"""Claude-written training plans, generated on demand from the app (never on a timer).

PLAN_MODE=plan           plan the dates in the request (max 7 days). Only those dates are replaced;
                         other future days of the existing plan are kept.
PLAN_MODE=refresh_today  re-balance only today's session after checking this morning's recovery.

The request (dates, constraints, optional note) is encrypted by the app and decrypted by the workflow into
build/request.json. Constraints are stored in the encrypted history, never in a public file.

Env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-sonnet-5-5), PLAN_DRY_RUN=1 (no API, for tests).
If the API call or the reply is unusable, the previous plan is kept and flagged stale.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

from common import ROOT, assemble, clean_constraints, load_config, load_state, save_state, tz

MODEL = os.environ.get("ANTHROPIC_MODEL") or "claude-sonnet-5-5"
MAX_DAYS = 7
REQUEST = os.path.join(ROOT, "build", "request.json")


# ------------------------------------------------------------------ context for the prompt
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
        if len(r) > 1:
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


def context(data, cfg):
    today = data["today"]
    since = (date.fromisoformat(today) - timedelta(days=13)).isoformat()
    recent = [compact_activity(a) for a in data["activities"] if a["date"] >= since]
    runs = [c for c in recent if c["type"] and "run" in c["type"] and c.get("pace")]
    load = data["load"][-1] if data["load"] else {}
    flags = [{"metric": k, "severity": v["label"], "detail": v["text"]} for k, v in (data.get("flags") or {}).items()]
    return {
        "today": today,
        "weekday_today": date.fromisoformat(today).strftime("%A"),
        "garmin_training_status": data.get("training_status"),
        "load_now": {"acute_7d": load.get("acute"), "chronic_weekly_avg_28d": load.get("chronic"), "ratio": load.get("ratio")},
        "baselines": baselines(data),
        "recovery_flags_right_now": flags,
        "recovery_last_10_days": recovery_rows(data),
        "activities_last_14_days": recent,
        "recent_run_paces": [{"date": r["date"], "pace": r["pace"], "km": r.get("km")} for r in runs[-5:]],
        "ftp_watts": cfg.get("ftp_watts"),
        "run_threshold_pace": cfg.get("run_threshold_pace"),
    }


DAY_SPEC = [
    "For a bike or run day include a \"structure\" array of blocks a Zwift .zwo file can encode:",
    "- Warmup/Cooldown: {\"kind\",\"duration\"(seconds),\"powerLow\",\"powerHigh\"} fractions of FTP (bike) or threshold pace (run)",
    "- SteadyState: {\"kind\",\"duration\",\"power\"}",
    "- Intervals: {\"kind\":\"Intervals\",\"repeat\",\"onDuration\",\"onPower\",\"offDuration\",\"offPower\"}",
    "- FreeRide: {\"kind\",\"duration\"}",
    "Omit \"structure\" for weights and rest days.",
    "",
    "For a run day include \"runPlan\" with paces in M:SS/km, calibrated strictly from run_threshold_pace if given, otherwise from recent_run_paces (recent easy pace anchors easy effort; faster for tempo, threshold, intervals). If neither exists, omit pace fields and describe effort in words.",
    '{"skipWarmupCooldown":bool,"warmup":null|{"pace_low","pace_high","duration_min"},"main":{"kind":"Steady|Tempo|Intervals|RampUp|LongRun|Recovery","description":"one sentence","pace_low","pace_high","duration_min","repeat","active_pace_low","active_pace_high","active_duration_min","rest_pace_low","rest_pace_high","rest_duration_min"},"cooldown":null|{...}}',
    "Intervals use repeat/active_*/rest_* instead of pace_low/pace_high/duration_min; every other kind omits those. Only easy steady runs may set skipWarmupCooldown true.",
    "",
    "For a weights day include \"focus\" (e.g. \"Lower body\", \"Upper body\", \"Full body\") and \"exercises\": up to 6 items {\"name\",\"sets\",\"reps\",\"note\"}.",
]
DAY_SHAPE = '{"date":"YYYY-MM-DD","type":"bike|run|weights|rest","session":"short title","detail":"one sentence","structure":[...],"runPlan":{...},"focus":"...","exercises":[...]}'
INTRO = "You are a professional endurance coach who specialises in hybrid athletes: people who want to gain muscle while training for running and cycling events."
RULES = [
    "- Recovery flags are computed from the athlete's Garmin data (Watch = yellow, Warning = orange, Alert = red). Red or several flags mean cut intensity or volume, never push through.",
    "- Hybrid interference: keep heavy lower-body strength at least 24 h away from quality run or bike sessions (ideally 48 h before a key long run).",
]


def constraints_line(constraints):
    return "Fixed constraints and events (respect exactly, fit everything else around them): " + (json.dumps(constraints, ensure_ascii=False) if constraints else "none")


def build_plan_prompt(data, cfg, dates, prev_plan, constraints, note):
    prev = [{"date": d["date"], "type": d["type"], "session": d["session"]} for d in (prev_plan or {}).get("days", []) if d["date"] >= data["today"] and d["date"] not in dates]
    return "\n".join([
        INTRO, "",
        f"Athlete goal: {cfg.get('goal')}",
        f"Target training days per week: {cfg.get('daysPerWeek')}",
        constraints_line(constraints),
        "Note from the athlete for this plan: " + (note or "none"), "",
        "Real data from the athlete's Garmin account. It is ground truth: do not invent sessions, sports or metrics that are not listed.",
        json.dumps({**context(data, cfg), "already_planned_days_outside_this_range": prev}, separators=(",", ":"), ensure_ascii=False), "",
        "Coaching rules:",
        "- Progress weekly load by roughly 5-10% at most. Keep the acute:chronic ratio between 0.8 and 1.3 unless the athlete clearly needs a deload.",
        "- Include at least one full rest or very light day per 7 days. Use \"rest\" for days off. Mostly easy aerobic volume (about 80%), one or two quality sessions a week.",
        *RULES,
        f"- Plan exactly these dates, one entry per date, in order: {', '.join(dates)}. Days already planned outside this range are listed so you can keep the week coherent; do not repeat them.", "",
        *DAY_SPEC, "",
        "Reply with ONLY a JSON object, no markdown fences, no commentary:",
        '{"last_week_summary":"2-3 sentences grounded in the data","readiness_note":"1-2 sentences on how recovery looks right now","today_adjustment":"one sentence, or empty string","fitness_note":"1-2 sentences on how the plan is calibrated toward the goal","days":[' + DAY_SHAPE + "]}",
    ])


def build_today_prompt(data, cfg, plan, constraints, note):
    today = data["today"]
    planned = next((d for d in (plan or {}).get("days", []) if d["date"] == today), None)
    upcoming = [{"date": d["date"], "type": d["type"], "session": d["session"], "detail": d["detail"]} for d in (plan or {}).get("days", []) if today < d["date"] <= (date.fromisoformat(today) + timedelta(days=3)).isoformat()]
    done = [compact_activity(a) for a in data["activities"] if a["date"] == today]
    return "\n".join([
        INTRO, "",
        "TASK: re-balance ONLY today's session. The athlete asked for a refresh, usually because recovery changed (bad night, tired, sore). Keep them active but match today's load to how recovered they are.", "",
        f"Athlete goal: {cfg.get('goal')}",
        constraints_line(constraints),
        "Note from the athlete: " + (note or "none"), "",
        "Real Garmin data (ground truth):",
        json.dumps({**context(data, cfg), "todays_planned_session": planned, "next_days_in_plan": upcoming, "activities_already_done_today": done}, separators=(",", ":"), ensure_ascii=False), "",
        "Rules:",
        *RULES,
        "- If recovery flags or the note point to fatigue: swap intensity for an easier option that still keeps them moving (easy Z1-Z2 aerobic, mobility, a short technique session) rather than a full rest, unless an Alert plus a note suggest rest. If recovery looks good, keep the planned session, or progress it slightly if the flags are clear and load is low.",
        "- Do not make tomorrow's planned session harder or impossible: keep today's load compatible with next_days_in_plan.",
        "- A fixed constraint that falls today (for example a scheduled event) must stay, but you may soften how you approach it (e.g. a shorter warm-up or easier effort around it).",
        "- If something was already done today, plan only a complementary light session or rest.", "",
        *DAY_SPEC, "",
        f'The day object must have date "{today}".',
        "Reply with ONLY a JSON object, no markdown fences:",
        '{"readiness_note":"1-2 sentences on how recovery looks this morning","today_adjustment":"one sentence on what changed and why (or that it stays as planned)","day":' + DAY_SHAPE + "}",
    ])


# ------------------------------------------------------------------ Claude call and parsing
def call_claude(prompt, max_tokens):
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    body = json.dumps({"model": MODEL, "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]}).encode()
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


def extract_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    return json.loads(text[text.find("{"):text.rfind("}") + 1])


def fix_day(d, iso):
    if not isinstance(d, dict):
        raise ValueError("day is not an object")
    d["date"] = iso
    if d.get("type") not in ("bike", "run", "weights", "rest"):
        d["type"] = "rest"
    d.setdefault("session", d["type"].title())
    d.setdefault("detail", "")
    return d


def parse_plan(text, dates):
    plan = extract_json(text)
    days = plan.get("days")
    if not isinstance(days, list) or len(days) != len(dates):
        raise ValueError(f"expected {len(dates)} days, got {len(days) if isinstance(days, list) else 'none'}")
    plan["days"] = [fix_day(d, iso) for d, iso in zip(days, dates)]
    return plan


def parse_today(text, iso):
    obj = extract_json(text)
    obj["day"] = fix_day(obj.get("day"), iso)
    obj["day"]["adjusted"] = True
    return obj


# ------------------------------------------------------------------ merge + request handling
def merge_plan(prev, new, today):
    """New days replace the same dates; every other future day of the previous plan is kept."""
    new_dates = {d["date"] for d in new["days"]}
    keep = [d for d in (prev or {}).get("days", []) if d["date"] >= today and d["date"] not in new_dates]
    return {**new, "days": sorted(keep + new["days"], key=lambda d: d["date"])}


def load_request():
    if os.path.exists(REQUEST):
        with open(REQUEST) as f:
            return json.load(f)
    return {}


def plan_dates(req, today):
    def parse(v):
        try:
            return date.fromisoformat(str(v))
        except ValueError:
            return None
    start = max(parse(req.get("from")) or today, today)
    end = parse(req.get("to")) or start + timedelta(days=MAX_DAYS - 1)
    end = max(start, min(end, start + timedelta(days=MAX_DAYS - 1)))
    return [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]


def dry_plan(dates):
    kinds = ["weights", "run", "bike", "rest", "run", "weights", "bike"]
    return {"last_week_summary": "Dry run placeholder.", "readiness_note": "", "today_adjustment": "",
            "fitness_note": "Placeholder plan, generated without the API.",
            "days": [{"date": d, "type": kinds[i % 7], "session": kinds[i % 7].title() + " session", "detail": "Placeholder."} for i, d in enumerate(dates)]}


def main():
    cfg = load_config()
    state = load_state()
    req = load_request()
    mode = os.environ.get("PLAN_MODE", "plan")
    if isinstance(req.get("constraints"), list):       # the popup always sends the full list
        state["constraints"] = clean_constraints(req["constraints"])
        print(f"[plan] constraints saved: {len(state['constraints'])}")
    note = " ".join(str(req.get("note") or "").split())[:500]
    data = assemble(state, cfg)
    today = data["today"]
    now = datetime.now(tz(cfg)).isoformat(timespec="seconds")
    dry = bool(os.environ.get("PLAN_DRY_RUN"))
    try:
        if mode == "refresh_today":
            if dry:
                obj = {"readiness_note": "", "today_adjustment": "Dry run.", "day": fix_day({"type": "run", "session": "Easy run", "detail": "Placeholder."}, today)}
                obj["day"]["adjusted"] = True
            else:
                obj = parse_today(call_claude(build_today_prompt(data, cfg, state.get("plan"), state.get("constraints", []), note), 3000), today)
            plan = state.get("plan") or {"days": [], "last_week_summary": "", "fitness_note": ""}
            plan["days"] = sorted([d for d in plan["days"] if d["date"] != today] + [obj["day"]], key=lambda d: d["date"])
            plan["readiness_note"] = obj.get("readiness_note", "")
            plan["today_adjustment"] = obj.get("today_adjustment", "")
            plan.update({"today_refreshed_at": now, "stale": False, "error": None})
            state["plan"] = plan
            print("[plan] today's session refreshed")
        else:
            dates = plan_dates(req, date.fromisoformat(today))
            if dry:
                new = dry_plan(dates)
            else:
                new = parse_plan(call_claude(build_plan_prompt(data, cfg, dates, state.get("plan"), state.get("constraints", []), note), 6000), dates)
            new.update({"generated_at": now, "model": "dry-run" if dry else MODEL, "stale": False, "error": None,
                        "range": {"from": dates[0], "to": dates[-1]}})
            state["plan"] = merge_plan(state.get("plan"), new, today)
            print("[plan] plan written for", dates[0], "->", dates[-1])
    except Exception as e:
        print("[plan] FAILED, keeping previous plan:", repr(e)[:400], file=sys.stderr)
        if state.get("plan"):
            state["plan"]["stale"] = True
            state["plan"]["error"] = repr(e)[:200]
        else:
            state["plan"] = {"days": [], "stale": True, "error": repr(e)[:200], "last_week_summary": "", "fitness_note": ""}
    save_state(state)


if __name__ == "__main__":
    main()
