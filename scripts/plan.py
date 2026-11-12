"""Generate the next 7 days of training with the Claude API, from the athlete's recent Garmin data.

Writes the result into build/state.json under "plan". If the API call or the reply is unusable,
the previous plan is kept and flagged stale, so the site always has something to show.

Env: ANTHROPIC_API_KEY (required), ANTHROPIC_MODEL (default claude-sonnet-5-5),
     PLAN_DRY_RUN=1 to skip the API and write a simple placeholder plan (used for local tests).
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from common import assemble, load_config, load_state, save_state, tz

MODEL = os.environ.get("ANTHROPIC_MODEL") or "claude-sonnet-5-5"
HORIZON = 7


def fmt_pace(speed):
    if not speed or speed <= 0:
        return None
    s = 1000 / speed
    m, sec = int(s // 60), round(s % 60)
    if sec == 60:
        m, sec = m + 1, 0
    return f"{m}:{sec:02d}/km"


def compact_activity(a):
    out = {"date": a["date"], "name": a["name"], "type": a["type"], "min": round((a["duration_s"] or 0) / 60)}
    if a.get("distance_m"):
        out["km"] = round(a["distance_m"] / 1000, 1)
    if a["sport_group"] == "run" and a.get("avg_speed"):
        out["pace"] = fmt_pace(a["avg_speed"])
    for k_src, k in (("avg_hr", "avg_hr"), ("max_hr", "max_hr"), ("load", "load"), ("te_aerobic", "te_aero"),
                     ("te_anaerobic", "te_anaero"), ("avg_power", "avg_w"), ("elev_gain_m", "elev_m")):
        if a.get(k_src):
            out[k] = round(a[k_src], 1) if isinstance(a[k_src], float) else a[k_src]
    return out


def recovery_rows(data, n=10):
    rows = []
    for d in data["daily"][-n:]:
        r = {"date": d["date"]}
        if d.get("rhr"):
            r["rhr"] = d["rhr"]
        if d.get("hrv"):
            r["hrv"] = d["hrv"].get("last")
            r["hrv_status"] = d["hrv"].get("status")
        if d.get("sleep"):
            r["sleep_h"] = round(d["sleep"]["total"] / 3600, 1)
            r["sleep_score"] = d["sleep"].get("score")
        if d.get("bb_high") is not None:
            r["body_battery_high"] = d["bb_high"]
        if d.get("readiness"):
            r["readiness"] = d["readiness"]["score"]
        rows.append(r)
    return rows


def baselines(data):
    def avg(vals):
        vals = [v for v in vals if v]
        return round(sum(vals) / len(vals), 1) if vals else None
    last30 = data["daily"][-30:]
    return {
        "rhr_30d_avg": avg([d.get("rhr") for d in last30]),
        "hrv_30d_avg": avg([(d.get("hrv") or {}).get("last") for d in last30]),
        "sleep_h_30d_avg": avg([d["sleep"]["total"] / 3600 for d in last30 if d.get("sleep")]),
    }


def build_prompt(data, cfg, dates, prev_plan):
    today = data["today"]
    recent = [compact_activity(a) for a in data["activities"] if a["date"] >= (datetime.fromisoformat(today) - timedelta(days=13)).date().isoformat()]
    runs = [c for c in recent if c["type"] and "run" in c["type"] and c.get("pace")]
    load = data["load"][-1] if data["load"] else {}
    prev_future = [d for d in (prev_plan or {}).get("days", []) if d["date"] >= today]
    ctx = {
        "today": today,
        "weekday_today": datetime.fromisoformat(today).strftime("%A"),
        "garmin_training_status": data.get("training_status"),
        "load_now": {"acute_7d": load.get("acute"), "chronic_weekly_avg_28d": load.get("chronic"), "ratio": load.get("ratio")},
        "baselines": baselines(data),
        "recovery_last_10_days": recovery_rows(data),
        "activities_last_14_days": recent,
        "recent_run_paces": [{"date": r["date"], "pace": r["pace"], "km": r.get("km")} for r in runs[-5:]],
        "previous_plan_for_upcoming_days": [{"date": d["date"], "type": d["type"], "session": d["session"]} for d in prev_future],
        "ftp_watts": cfg.get("ftp_watts"),
        "run_threshold_pace": cfg.get("run_threshold_pace"),
    }
    constraints = [c for c in cfg.get("constraints", []) if c and "(delete this line)" not in c]
    return "\n".join([
        "You are a professional endurance coach who specialises in hybrid athletes: people who want to gain muscle while training for running and cycling events.",
        "",
        f"Athlete goal: {cfg.get('goal')}",
        f"Target training days per week: {cfg.get('daysPerWeek')}",
        "Fixed constraints / events (respect exactly, fit everything else around them): " + (json.dumps(constraints) if constraints else "none"),
        "",
        "Real data from the athlete's Garmin account. It is ground truth: do not invent sessions, sports or metrics that are not listed.",
        json.dumps(ctx, separators=(",", ":")),
        "",
        "Coaching rules:",
        "- Today's plan is decided this morning. If recovery is poor (HRV below its baseline or status not balanced, resting HR 4+ bpm above the 30 day average, sleep under 6 h or a low sleep score, low body battery or readiness), cut intensity or volume today and say so in today_adjustment. If recovery is good and load is low, you may progress.",
        "- Progress weekly load by roughly 5-10% at most. Keep the acute:chronic ratio between 0.8 and 1.3 unless the athlete clearly needs a deload.",
        "- Hybrid interference: keep heavy lower-body strength at least 24 h away from quality run or bike sessions (ideally 48 h before a key long run). Prefer upper-body or short strength on days with hard endurance, and easy aerobic work after lower-body days.",
        "- Include at least one full rest or very light day. Use \"rest\" for days off.",
        "- Mostly easy aerobic volume (about 80%), with one or two quality sessions a week.",
        f"- Plan exactly these dates, one entry per date, in order: {', '.join(dates)}.",
        "",
        "For every bike or run day include a \"structure\" array of blocks a Zwift .zwo file can encode:",
        "- Warmup/Cooldown: {\"kind\",\"duration\"(seconds),\"powerLow\",\"powerHigh\"} fractions of FTP (bike) or threshold pace (run)",
        "- SteadyState: {\"kind\",\"duration\",\"power\"}",
        "- Intervals: {\"kind\":\"Intervals\",\"repeat\",\"onDuration\",\"onPower\",\"offDuration\",\"offPower\"}",
        "- FreeRide: {\"kind\",\"duration\"}",
        "Omit \"structure\" for weights and rest days.",
        "",
        "For every run day include \"runPlan\" with paces in M:SS/km, calibrated strictly from run_threshold_pace if given, otherwise from recent_run_paces (recent easy pace anchors easy effort; faster for tempo, threshold, intervals). If neither exists, omit pace fields and describe effort in words.",
        '{"skipWarmupCooldown":bool,"warmup":null|{"pace_low","pace_high","duration_min"},"main":{"kind":"Steady|Tempo|Intervals|RampUp|LongRun|Recovery","description":"one sentence","pace_low","pace_high","duration_min","repeat","active_pace_low","active_pace_high","active_duration_min","rest_pace_low","rest_pace_high","rest_duration_min"},"cooldown":null|{...}}',
        "Intervals use repeat/active_*/rest_* instead of pace_low/pace_high/duration_min; every other kind omits those. Only easy steady runs may set skipWarmupCooldown true.",
        "",
        "For every weights day include \"focus\" (e.g. \"Lower body\", \"Upper body\", \"Full body\") and \"exercises\": up to 6 items {\"name\",\"sets\",\"reps\",\"note\"}.",
        "",
        "Reply with ONLY a JSON object, no markdown fences, no commentary:",
        '{"last_week_summary":"2-3 sentences grounded in the data","readiness_note":"1-2 sentences on how recovery looks this morning","today_adjustment":"one sentence, or empty string if none","fitness_note":"1-2 sentences on how the week is calibrated toward the goal","days":[{"date":"YYYY-MM-DD","type":"bike|run|weights|rest","session":"short title","detail":"one sentence","structure":[...],"runPlan":{...},"focus":"...","exercises":[...]}]}',
    ])


def call_claude(prompt):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    body = json.dumps({"model": MODEL, "max_tokens": 6000, "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, method="POST", headers={
        "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Anthropic API {e.code}: {e.read().decode()[:300]}")
    text = "".join(b.get("text", "") for b in resp.get("content", []) if b.get("type") == "text")
    usage = resp.get("usage", {})
    print(f"[plan] model={MODEL} in={usage.get('input_tokens')} out={usage.get('output_tokens')}")
    return text


def parse_plan(text, dates):
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    start, end = text.find("{"), text.rfind("}")
    plan = json.loads(text[start:end + 1])
    days = plan.get("days")
    if not isinstance(days, list) or len(days) != len(dates):
        raise ValueError(f"expected {len(dates)} days, got {len(days) if isinstance(days, list) else 'none'}")
    for d, iso in zip(days, dates):
        d["date"] = iso
        if d.get("type") not in ("bike", "run", "weights", "rest"):
            d["type"] = "rest"
    return plan


def dry_run_plan(dates):
    kinds = ["weights", "run", "bike", "rest", "run", "weights", "bike"]
    return {"last_week_summary": "Dry run placeholder.", "readiness_note": "", "today_adjustment": "",
            "fitness_note": "Placeholder plan, generated without the API.",
            "days": [{"date": d, "type": kinds[i % 7], "session": kinds[i % 7].title() + " session",
                      "detail": "Placeholder."} for i, d in enumerate(dates)]}


def main():
    cfg = load_config()
    state = load_state()
    data = assemble(state, cfg)
    today = datetime.fromisoformat(data["today"]).date()
    dates = [(today + timedelta(days=i)).isoformat() for i in range(HORIZON)]
    try:
        if os.environ.get("PLAN_DRY_RUN"):
            plan = dry_run_plan(dates)
        else:
            plan = parse_plan(call_claude(build_prompt(data, cfg, dates, state.get("plan"))), dates)
        plan["generated_at"] = datetime.now(tz(cfg)).isoformat(timespec="seconds")
        plan["model"] = "dry-run" if os.environ.get("PLAN_DRY_RUN") else MODEL
        plan["stale"] = False
        state["plan"] = plan
        print("[plan] new plan written for", dates[0], "->", dates[-1])
    except Exception as e:
        print("[plan] FAILED, keeping previous plan:", repr(e)[:400], file=sys.stderr)
        if state.get("plan"):
            state["plan"]["stale"] = True
            state["plan"]["error"] = repr(e)[:200]
    save_state(state)


if __name__ == "__main__":
    main()
