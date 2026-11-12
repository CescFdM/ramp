"""Pull activities, sleep, HRV, resting HR, body battery, weight and training status from
Garmin Connect into build/state.json (incremental: only missing days are fetched).

Uses the unofficial `garminconnect` library. Auth, in order:
  1. saved tokens (GARMIN_TOKENS_B64 secret, a base64 tar.gz of the token directory)
  2. GARMIN_EMAIL + GARMIN_PASSWORD
Every Garmin call is wrapped: a failing endpoint is logged and skipped, never fatal,
unless login itself fails.
"""
import base64
import io
import os
import sys
import tarfile
import time
from datetime import date, datetime, timedelta, timezone

from common import (DAILY_DAYS, DETAIL_DAYS, HISTORY_DAYS, load_config, load_state,
                    save_state, sport_group, today_local)

TOKENDIR = os.path.expanduser(os.environ.get("GARMINTOKENS", "~/.garminconnect"))


def log(*a):
    print("[sync]", *a, flush=True)


def restore_tokens():
    b64 = os.environ.get("GARMIN_TOKENS_B64", "").strip()
    if not b64:
        return False
    os.makedirs(TOKENDIR, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(base64.b64decode(b64)), mode="r:gz") as t:
        t.extractall(TOKENDIR, filter="data")
    return True


def login():
    from garminconnect import Garmin
    have_tokens = restore_tokens()
    email, pw = os.environ.get("GARMIN_EMAIL"), os.environ.get("GARMIN_PASSWORD")
    if have_tokens:
        try:
            g = Garmin()
            g.login(TOKENDIR)
            log("logged in with saved tokens")
            return g
        except Exception as e:  # expired or unreadable tokens
            log("token login failed:", repr(e)[:200])
    if not (email and pw):
        sys.exit("No valid Garmin tokens and no GARMIN_EMAIL / GARMIN_PASSWORD set.")
    g = Garmin(email, pw)
    g.login(TOKENDIR)
    log("logged in with email + password")
    return g


class Api:
    """Thin wrapper: retry on rate limits, swallow per-endpoint failures."""

    def __init__(self, g):
        self.g = g
        self.failures = {}

    def call(self, name, *args, **kw):
        for attempt in range(4):
            try:
                return getattr(self.g, name)(*args, **kw)
            except Exception as e:
                msg = repr(e)
                if "429" in msg or "Too Many" in msg:
                    wait = 20 * (attempt + 1)
                    log(f"{name}: rate limited, sleeping {wait}s")
                    time.sleep(wait)
                    continue
                self.failures[name] = self.failures.get(name, 0) + 1
                if self.failures[name] <= 2:
                    log(f"{name}{args}: {msg[:160]}")
                return None
        return None


def g(d, *path, default=None):
    for p in path:
        if isinstance(d, dict):
            d = d.get(p)
        elif isinstance(d, list) and isinstance(p, int) and p < len(d):
            d = d[p]
        else:
            return default
        if d is None:
            return default
    return d


def summarize_activity(a):
    type_key = g(a, "activityType", "typeKey", default="other")
    start = a.get("startTimeLocal") or ""
    return {
        "id": a.get("activityId"),
        "date": start[:10],
        "start_local": start.replace(" ", "T")[:19],
        "name": a.get("activityName") or type_key,
        "type": type_key,
        "sport_group": sport_group(type_key),
        "duration_s": a.get("duration"),
        "moving_s": a.get("movingDuration"),
        "distance_m": a.get("distance"),
        "elev_gain_m": a.get("elevationGain"),
        "avg_speed": a.get("averageSpeed"),
        "max_speed": a.get("maxSpeed"),
        "avg_hr": a.get("averageHR"),
        "max_hr": a.get("maxHR"),
        "calories": a.get("calories"),
        "te_aerobic": a.get("aerobicTrainingEffect"),
        "te_anaerobic": a.get("anaerobicTrainingEffect"),
        "te_label": a.get("trainingEffectLabel"),
        "load": a.get("activityTrainingLoad"),
        "avg_power": a.get("avgPower"),
        "norm_power": a.get("normPower"),
        "max_power": a.get("maxPower"),
        "cadence": a.get("averageRunningCadenceInStepsPerMinute") or a.get("averageBikingCadenceInRevPerMinute"),
        "vo2max": a.get("vO2MaxValue"),
        "steps": a.get("steps"),
        "sets": a.get("totalSets"),
        "reps": a.get("totalReps"),
        "location": a.get("locationName"),
    }


def fetch_detail(api, act):
    aid = act["id"]
    out = {}
    det = api.call("get_activity_details", aid, maxchart=400, maxpoly=250)
    if det:
        keys = {m.get("metricsIndex"): m.get("key") for m in det.get("metricDescriptors", [])}
        want = {"directHeartRate": "hr", "directSpeed": "speed", "directElevation": "elev",
                "directRunCadence": "cad", "directBikeCadence": "cad", "directPower": "power",
                "sumDuration": "t", "sumDistance": "dist"}
        series = {v: [] for v in set(want.values())}
        for row in det.get("activityDetailMetrics", []):
            m = row.get("metrics", [])
            for idx, key in keys.items():
                if key in want and idx is not None and idx < len(m):
                    series[want[key]].append(m[idx])
        series = {k: v for k, v in series.items() if v and any(x is not None for x in v)}
        if series:
            out["series"] = series
        poly = g(det, "geoPolylineDTO", "polyline", default=[])
        if poly:
            out["route"] = [[round(p["lat"], 5), round(p["lon"], 5)] for p in poly if "lat" in p and "lon" in p]
    splits = api.call("get_activity_splits", aid)
    laps = g(splits, "lapDTOs", default=[]) if splits else []
    if laps:
        out["laps"] = [{
            "n": i + 1, "dist_m": l.get("distance"), "dur_s": l.get("duration"),
            "speed": l.get("averageSpeed"), "hr": l.get("averageHR"),
            "elev_gain": l.get("elevationGain"), "power": l.get("averagePower"),
        } for i, l in enumerate(laps)]
    zones = api.call("get_activity_hr_in_timezones", aid)
    if zones:
        out["hr_zones"] = [{"zone": z.get("zoneNumber"), "secs": z.get("secsInZone"),
                            "low": z.get("zoneLowBoundary")} for z in zones]
    if act["sport_group"] == "strength":
        sets = api.call("get_activity_exercise_sets", aid)
        rows = []
        for s in g(sets, "exerciseSets", default=[]) if sets else []:
            if s.get("setType") == "REST":
                continue
            ex = (s.get("exercises") or [{}])[0]
            rows.append({"name": (ex.get("name") or ex.get("category") or "Set").replace("_", " ").title(),
                         "reps": s.get("repetitionCount"),
                         "kg": round(s["weight"] / 1000.0, 1) if s.get("weight") else None,
                         "dur_s": s.get("duration")})
        if rows:
            out["sets"] = rows
    return out


def fetch_day(api, day):
    iso = day.isoformat()
    row = {}
    stats = api.call("get_stats", iso)
    if stats:
        row["rhr"] = stats.get("restingHeartRate")
        row["bb_high"] = stats.get("bodyBatteryHighestValue")
        row["bb_low"] = stats.get("bodyBatteryLowestValue")
        row["stress"] = stats.get("averageStressLevel")
        row["steps"] = stats.get("totalSteps")
    sleep = api.call("get_sleep_data", iso)
    dto = g(sleep, "dailySleepDTO", default={}) if sleep else {}
    if dto.get("sleepTimeSeconds"):
        row["sleep"] = {
            "total": dto.get("sleepTimeSeconds"), "deep": dto.get("deepSleepSeconds"),
            "light": dto.get("lightSleepSeconds"), "rem": dto.get("remSleepSeconds"),
            "awake": dto.get("awakeSleepSeconds"),
            "score": g(dto, "sleepScores", "overall", "value"),
            "start": dto.get("sleepStartTimestampLocal"), "end": dto.get("sleepEndTimestampLocal"),
        }
        if row.get("rhr") is None:
            row["rhr"] = (sleep or {}).get("restingHeartRate")
    mm = api.call("get_max_metrics", iso)  # account-level VO2max, independent of any single activity
    mm = mm[0] if isinstance(mm, list) and mm else mm
    if day == date.today() or os.environ.get("DEBUG_VO2"):
        log("get_max_metrics", iso, "->", (list(mm.keys()), {k: (list(v.keys()) if isinstance(v, dict) else v) for k, v in mm.items()}) if isinstance(mm, dict) else repr(mm)[:200])
    if isinstance(mm, dict):
        vo2 = {"run": g(mm, "generic", "vo2MaxPreciseValue") or g(mm, "generic", "vo2MaxValue"),
               "bike": g(mm, "cycling", "vo2MaxPreciseValue") or g(mm, "cycling", "vo2MaxValue")}
        vo2 = {k: round(float(v), 1) for k, v in vo2.items() if v}
        if vo2:
            row["vo2"] = vo2
    hrv = api.call("get_hrv_data", iso)
    s = g(hrv, "hrvSummary", default=None) if hrv else None
    if s:
        row["hrv"] = {
            "last": s.get("lastNightAvg"), "weekly": s.get("weeklyAvg"), "status": s.get("status"),
            "low": g(s, "baseline", "balancedLow"), "high": g(s, "baseline", "balancedUpper"),
        }
    return {k: v for k, v in row.items() if v is not None}


def main():
    cfg = load_config()
    today = today_local(cfg)
    state = load_state()
    state.setdefault("daily", {}), state.setdefault("activities", {})
    state.setdefault("details", {}), state.setdefault("weights", {}), state.setdefault("meta", {})
    api = Api(login())

    # --- activities: full refresh of the window (one paged call) -------------------------
    start = today - timedelta(days=HISTORY_DAYS)
    raw = api.call("get_activities_by_date", start.isoformat(), today.isoformat()) or []
    acts = {str(a["activityId"]): summarize_activity(a) for a in raw if a.get("activityId")}
    if acts:
        state["activities"] = acts
    log(f"{len(acts)} activities in the last {HISTORY_DAYS} days")

    # --- activity detail for the last 7 days (cached by id) ------------------------------
    cutoff = (today - timedelta(days=DETAIL_DAYS - 1)).isoformat()
    recent = [a for a in state["activities"].values() if a["date"] >= cutoff]
    for a in recent:
        if str(a["id"]) not in state["details"]:
            state["details"][str(a["id"])] = fetch_detail(api, a)
            time.sleep(0.4)
    state["details"] = {k: v for k, v in state["details"].items() if k in {str(a["id"]) for a in recent}}

    # --- wellness: missing days + last 3 days (Garmin revises recent sleep/HRV) ------------
    # Only look back BACKFILL_DAYS for gaps (default 30). History older than that accumulates
    # forward day by day; raise BACKFILL_DAYS on a manual run to pull more.
    backfill = int(os.environ.get("BACKFILL_DAYS") or 30)
    days = [today - timedelta(days=i) for i in range(DAILY_DAYS)]
    todo = [d for d in days[:backfill] if d.isoformat() not in state["daily"] or d >= today - timedelta(days=2)]
    log(f"fetching {len(todo)} wellness days (backfill window {backfill} days)")
    for d in sorted(todo):
        row = fetch_day(api, d)
        if row:
            state["daily"][d.isoformat()] = row
        time.sleep(0.3)
    keep = {d.isoformat() for d in days}
    state["daily"] = {k: v for k, v in state["daily"].items() if k in keep}

    # --- readiness for the last 3 days (accumulates over time) ---------------------------
    for d in [today - timedelta(days=i) for i in range(3)]:
        r = api.call("get_training_readiness", d.isoformat())
        r = r[0] if isinstance(r, list) and r else r
        if isinstance(r, dict) and r.get("score") is not None and d.isoformat() in state["daily"]:
            state["daily"][d.isoformat()]["readiness"] = {"score": r.get("score"), "level": r.get("level")}

    # --- weight / body composition ---------------------------------------------------------
    w = api.call("get_weigh_ins", (today - timedelta(days=DAILY_DAYS)).isoformat(), today.isoformat())
    for item in g(w, "dailyWeightSummaries", default=[]) if w else []:
        lw = item.get("latestWeight") or {}
        if lw.get("weight"):
            state["weights"][item["summaryDate"]] = {
                "kg": round(lw["weight"] / 1000.0, 1),
                "fat": lw.get("bodyFat"), "muscle_kg": round(lw["muscleMass"] / 1000.0, 1) if lw.get("muscleMass") else None,
            }

    # --- training status (latest) -------------------------------------------------------------
    ts = api.call("get_training_status", today.isoformat())
    if ts:
        latest = g(ts, "mostRecentTrainingStatus", "latestTrainingStatusData", default={}) or {}
        first = next(iter(latest.values()), {}) if isinstance(latest, dict) else {}
        state["meta"]["training_status"] = {
            "phrase": first.get("trainingStatusFeedbackPhrase"),
            "acute": g(first, "acuteTrainingLoadDTO", "dailyTrainingLoadAcute"),
            "chronic": g(first, "acuteTrainingLoadDTO", "dailyTrainingLoadChronic"),
            "ratio": g(first, "acuteTrainingLoadDTO", "dailyAcuteChronicWorkloadRatio"),
            "vo2_run": g(ts, "mostRecentVO2Max", "generic", "vo2MaxPreciseValue"),
            "vo2_bike": g(ts, "mostRecentVO2Max", "cycling", "vo2MaxPreciseValue"),
        }

    state["meta"]["sync"] = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                             "failures": api.failures}
    save_state(state)
    log("done; endpoint failures:", api.failures or "none")


if __name__ == "__main__":
    main()
