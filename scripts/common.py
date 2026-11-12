"""Shared helpers: paths, state IO, derived metrics, assembling the site payload."""
import json
import os
import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
STATE_JSON = os.path.join(BUILD, "state.json")
DATA_JSON = os.path.join(BUILD, "data.json")
CONFIG = os.path.join(ROOT, "config", "athlete.json")

HISTORY_DAYS = 120   # activity summaries kept
DAILY_DAYS = 120     # wellness days kept
DETAIL_DAYS = 7      # activities with full detail (charts, splits, route)


def _lenient_json(text):
    """json.loads that tolerates trailing commas (a common hand-editing slip on GitHub)."""
    return json.loads(re.sub(r",\s*([\]}])", r"\1", text))


def load_config():
    with open(CONFIG) as f:
        return _lenient_json(f.read())


def clean_constraints(items):
    out = []
    for c in items or []:
        c = " ".join(str(c).split())[:300]
        if c and "(delete this line)" not in c and c not in out:
            out.append(c)
    return out[:30]


def migrate_legacy_constraints(state):
    """Constraints used to live in the public config/athlete.json. Import them once into the
    encrypted state and remove them from the file. Returns True if the file was rewritten."""
    with open(CONFIG) as f:
        cfg = _lenient_json(f.read())
    legacy = cfg.pop("constraints", None)
    if legacy is None:
        return False
    if "constraints" not in state:
        state["constraints"] = clean_constraints(legacy)
    with open(CONFIG, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return True


def tz(cfg=None):
    return ZoneInfo((cfg or load_config()).get("timezone", "Europe/Berlin"))


def today_local(cfg=None):
    return datetime.now(tz(cfg)).date()


def load_state():
    if os.path.exists(STATE_JSON):
        with open(STATE_JSON) as f:
            return json.load(f)
    return {"daily": {}, "activities": {}, "details": {}, "weights": {}, "plan": None, "meta": {}}


def save_state(state):
    os.makedirs(BUILD, exist_ok=True)
    with open(STATE_JSON, "w") as f:
        json.dump(state, f, separators=(",", ":"))


def sport_group(type_key):
    k = (type_key or "").lower()
    if "strength" in k or k in ("hiit", "fitness_equipment", "indoor_cardio"):
        return "strength"
    if "run" in k:
        return "run"
    if "cycl" in k or "bik" in k or "ride" in k or k in ("e_bike_fitness", "mountain_biking"):
        return "bike"
    if k in ("hiking", "walking", "casual_walking", "speed_walking"):
        return "walk"
    return "other"


def est_load(a):
    """Garmin's activity training load when present, else a duration based estimate."""
    v = a.get("load")
    if v:
        return float(v)
    mins = (a.get("duration_s") or 0) / 60.0
    factor = {"run": 1.1, "bike": 0.8, "strength": 0.6, "walk": 0.25, "other": 0.5}[a.get("sport_group", "other")]
    return round(mins * factor, 1)


def compute_load_series(activities, start, end):
    """Daily load, 7 day acute load and 28 day chronic (weekly average) load."""
    by_day = {}
    for a in activities:
        by_day[a["date"]] = by_day.get(a["date"], 0) + est_load(a)
    out = []
    d = start
    while d <= end:
        def window(n):
            return [by_day.get((d - timedelta(days=i)).isoformat(), 0) for i in range(n)]
        acute = sum(window(7))
        chronic = sum(window(28)) / 4.0
        out.append({
            "date": d.isoformat(),
            "load": round(by_day.get(d.isoformat(), 0), 1),
            "acute": round(acute, 1),
            "chronic": round(chronic, 1),
            "ratio": round(acute / chronic, 2) if chronic > 0 else None,
        })
        d += timedelta(days=1)
    return out


LEVEL_LABEL = {1: "Watch", 2: "Warning", 3: "Alert"}


def _avg(vals):
    vals = [v for v in vals if v is not None]
    return sum(vals) / len(vals) if vals else None


def compute_flags(daily, training_status, cfg, today):
    """Stat highlights shared by the app and the planner. level 1 yellow, 2 orange, 3 red.
    Only data from today or yesterday counts, so a stale value never raises an alert."""
    th = {"rhr_delta": 2, "sleep_score_min": 70, "sleep_hours_min": 6, "body_battery_min": 80, **cfg.get("thresholds", {})}
    levels = cfg.get("levels", {})
    fresh_from = (today - timedelta(days=1)).isoformat()
    fresh = [d for d in reversed(daily) if d["date"] >= fresh_from]
    flags = {}

    def latest(fn):
        for d in fresh:
            v = fn(d)
            if v is not None:
                return v, d
        return None

    r = latest(lambda d: d.get("rhr"))
    if r:
        val, day = r
        base = _avg([x.get("rhr") for x in [x for x in daily if x["date"] < day["date"]][-30:]])
        if base and val - base > th["rhr_delta"]:
            flags["rhr"] = {"level": 3, "text": f"+{val - base:.1f} vs 30d avg"}
    h = latest(lambda d: (d.get("hrv") or {}).get("status"))
    if h:
        status = str(h[0]).upper()
        lvl = levels.get("hrv", {}).get(status)
        if lvl:
            flags["hrv"] = {"level": lvl, "text": status.capitalize()}
    sl = latest(lambda d: (d.get("sleep") or {}).get("total"))
    if sl:
        total, day = sl
        score, reasons = (day["sleep"] or {}).get("score"), []
        if score is not None and score < th["sleep_score_min"]:
            reasons.append(f"Score {score}")
        if total / 3600 < th["sleep_hours_min"]:
            reasons.append(f"{int(total // 3600)}h {int(total % 3600 // 60):02d}m")
        if reasons:
            flags["sleep"] = {"level": 3, "text": " · ".join(reasons)}
    bb = latest(lambda d: d.get("bb_high"))
    if bb and bb[0] < th["body_battery_min"]:
        flags["body_battery"] = {"level": 3, "text": f"Peak only {bb[0]}"}
    phrase = re.sub(r"_\d+$", "", str((training_status or {}).get("phrase") or "")).upper()
    for key, lvl in levels.get("training_status", {}).items():
        if phrase.startswith(key):
            flags["status"] = {"level": lvl, "text": phrase.capitalize()}
            break
    for f in flags.values():
        f["label"] = LEVEL_LABEL.get(f["level"], "")
    return flags


def assemble(state, cfg=None):
    """Build the payload the website decrypts. Everything the UI needs, nothing else."""
    cfg = cfg or load_config()
    today = today_local(cfg)
    acts = sorted(state.get("activities", {}).values(), key=lambda a: a["start_local"])
    start = today - timedelta(days=DAILY_DAYS - 1)
    daily = [dict(date=d, **v) for d, v in sorted(state.get("daily", {}).items()) if d >= start.isoformat()]
    weights = [dict(date=d, **v) for d, v in sorted(state.get("weights", {}).items()) if d >= start.isoformat()]
    cutoff = (today - timedelta(days=DETAIL_DAYS - 1)).isoformat()
    recent_ids = {str(a["id"]) for a in acts if a["date"] >= cutoff}
    details = {k: v for k, v in state.get("details", {}).items() if k in recent_ids}
    return {
        "generated_at": datetime.now(tz(cfg)).isoformat(timespec="seconds"),
        "build": (os.environ.get("GITHUB_SHA") or "local")[:7],
        "today": today.isoformat(),
        "timezone": cfg.get("timezone"),
        "profile": {"goal": cfg.get("goal"), "daysPerWeek": cfg.get("daysPerWeek")},
        "daily": daily,
        "weights": weights,
        "activities": acts,
        "load": compute_load_series(acts, start, today),
        "training_status": state.get("meta", {}).get("training_status"),
        "flags": compute_flags(daily, state.get("meta", {}).get("training_status"), cfg, today),
        "constraints": state.get("constraints", []),
        "details": details,
        "plan": state.get("plan"),
        "sync": state.get("meta", {}).get("sync"),
    }


def save_data(data):
    os.makedirs(BUILD, exist_ok=True)
    with open(DATA_JSON, "w") as f:
        json.dump(data, f, separators=(",", ":"))
