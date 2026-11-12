"""Write a realistic synthetic build/state.json so the site can be developed and tested
without a Garmin account. Usage: python scripts/demo_data.py  (then assemble.py, plan with PLAN_DRY_RUN=1)."""
import math
import random
from datetime import datetime, timedelta

from common import load_config, save_state, sport_group, today_local

random.seed(7)
cfg = load_config()
today = today_local(cfg)
state = {"daily": {}, "activities": {}, "details": {}, "weights": {}, "plan": None, "meta": {}}

# ---- wellness: 120 days
for i in range(120):
    d = today - timedelta(days=119 - i)
    trend = i / 120
    rhr = round(54 - 3 * trend + random.gauss(0, 1.2))
    hrv = round(52 + 8 * trend + random.gauss(0, 5))
    total = int((6.6 + random.gauss(0, 0.7)) * 3600)
    deep, rem = int(total * random.uniform(.14, .2)), int(total * random.uniform(.18, .25))
    awake = int(total * random.uniform(.04, .09))
    state["daily"][d.isoformat()] = {
        "rhr": rhr, "bb_high": min(100, round(78 + random.gauss(0, 10))), "bb_low": round(18 + random.gauss(0, 6)),
        "stress": round(30 + random.gauss(0, 6)), "steps": int(8000 + random.gauss(0, 2500)),
        "sleep": {"total": total, "deep": deep, "rem": rem, "awake": awake, "light": total - deep - rem - awake,
                  "score": max(40, min(97, round(76 + random.gauss(0, 8))))},
        "hrv": {"last": hrv, "weekly": hrv - 1, "status": random.choice(["BALANCED", "BALANCED", "BALANCED", "UNBALANCED"]),
                "low": 46, "high": 62},
    }
    state["daily"][d.isoformat()]["vo2"] = {"run": round(49 + 1.6 * trend + random.gauss(0, .15), 1), "bike": round(51 + 1.2 * trend + random.gauss(0, .15), 1)}
    if i > 112:
        state["daily"][d.isoformat()]["readiness"] = {"score": random.randint(45, 90), "level": "MODERATE"}
    if i % 5 == 0:
        state["weights"][d.isoformat()] = {"kg": round(78.4 + 1.2 * trend + random.gauss(0, .3), 1), "fat": round(17.5 - 1.2 * trend, 1),
                                           "muscle_kg": round(35.2 + 0.8 * trend, 1)}

# make the latest day trip several highlight levels (for UI testing)
_last = state["daily"][max(state["daily"])]
_last["rhr"] = 58; _last["hrv"]["status"] = "LOW"; _last["bb_high"] = 72
_last["sleep"].update({"total": int(5.4 * 3600), "score": 62})

# ---- activities
week = ["strength_training", "running", "cycling", None, "running", "strength_training", "cycling"]
aid = 1000
for i in range(120):
    d = today - timedelta(days=119 - i)
    kind = week[d.weekday()]
    if kind is None or random.random() < .12:
        continue
    if kind == "cycling" and d.weekday() == 6:
        dur, dist = random.randint(130, 190) * 60, None
    hh = random.randint(6, 18)
    if kind == "running":
        dur = random.randint(35, 75) * 60; speed = random.uniform(2.75, 3.2)
    elif kind == "cycling":
        dur = random.randint(60, 190) * 60; speed = random.uniform(6.8, 8.6)
    else:
        dur = random.randint(40, 65) * 60; speed = 0
    aid += 1
    ty = "virtual_ride" if (kind == "cycling" and d.weekday() == 2) else kind
    a = {"id": aid, "date": d.isoformat(), "start_local": f"{d.isoformat()}T{hh:02d}:{random.randint(0, 59):02d}:00",
         "name": {"running": "Easy run", "cycling": "Endurance ride", "strength_training": "Strength", "virtual_ride": "Zwift - Endurance"}.get(ty, ty),
         "type": ty, "sport_group": sport_group(ty), "duration_s": dur, "moving_s": dur - 60,
         "distance_m": round(dur * speed) if speed else None, "elev_gain_m": random.randint(20, 900) if speed else None,
         "avg_speed": round(speed, 2) if speed else None, "max_speed": round(speed * 1.6, 2) if speed else None,
         "avg_hr": random.randint(118, 158), "max_hr": random.randint(160, 186), "calories": int(dur / 60 * 9),
         "te_aerobic": round(random.uniform(2, 4.4), 1), "te_anaerobic": round(random.uniform(0, 2), 1), "te_label": "TEMPO",
         "load": round(dur / 60 * random.uniform(.8, 1.5)), "avg_power": random.randint(150, 220) if kind == "cycling" else None,
         "norm_power": random.randint(165, 240) if kind == "cycling" else None, "max_power": random.randint(400, 700) if kind == "cycling" else None,
         "cadence": random.randint(160, 176) if kind == "running" else (random.randint(80, 92) if kind == "cycling" else None),
         "vo2max": round(49 + random.gauss(0, .6), 1) if kind in ("running", "cycling") else None,
         "sets": 18 if kind == "strength_training" else None, "reps": 160 if kind == "strength_training" else None,
         "location": "Barcelona" if speed else None}
    state["activities"][str(aid)] = a

# ---- details for the last 7 days
cut = (today - timedelta(days=6)).isoformat()
for k, a in state["activities"].items():
    if a["date"] < cut:
        continue
    n = 120
    det = {}
    if a["sport_group"] != "strength":
        t = [round(i * a["duration_s"] / (n - 1)) for i in range(n)]
        hr = [round(a["avg_hr"] + 14 * math.sin(i / 9) + 8 * (i / n) + random.gauss(0, 2)) for i in range(n)]
        sp = [round(max(0.5, a["avg_speed"] * (1 + .12 * math.sin(i / 7) + random.gauss(0, .03))), 2) for i in range(n)]
        el = [round(60 + 40 * math.sin(i / 17) + 15 * math.sin(i / 5)) for i in range(n)]
        det["series"] = {"t": t, "hr": hr, "speed": sp, "elev": el, "dist": [round(i * a["distance_m"] / (n - 1)) for i in range(n)]}
        if a["avg_power"]:
            det["series"]["power"] = [max(0, round(a["avg_power"] + 60 * math.sin(i / 6) + random.gauss(0, 20))) for i in range(n)]
        det["route"] = [[round(41.39 + 0.02 * math.sin(i / 14) + 0.004 * i / n, 5), round(2.17 + 0.03 * math.cos(i / 20) * (1 + i / n), 5)] for i in range(n)]
        km = max(1, int(a["distance_m"] / 1000))
        det["laps"] = [{"n": i + 1, "dist_m": 1000, "dur_s": round(1000 / a["avg_speed"] * random.uniform(.95, 1.05)),
                        "speed": round(a["avg_speed"] * random.uniform(.93, 1.07), 2), "hr": random.randint(130, 170),
                        "elev_gain": random.randint(0, 25), "power": None} for i in range(min(km, 14))]
        zs = [random.randint(60, 600) for _ in range(5)]
        det["hr_zones"] = [{"zone": i + 1, "secs": s, "low": [100, 120, 140, 158, 175][i]} for i, s in enumerate(zs)]
    else:
        names = ["Back Squat", "Romanian Deadlift", "Bench Press", "Barbell Row", "Overhead Press", "Lunge"]
        det["sets"] = [{"name": nme, "reps": random.choice([5, 6, 8, 10]), "kg": round(random.choice([40, 50, 60, 70, 80]) + 2.5 * j, 1), "dur_s": 40}
                       for nme in names for j in range(3)]
        det["hr_zones"] = [{"zone": i + 1, "secs": s, "low": [100, 120, 140, 158, 175][i]} for i, s in enumerate([900, 1200, 500, 120, 0])]
    state["details"][k] = det

state["meta"]["training_status"] = {"phrase": "MAINTAINING_1", "acute": 612, "chronic": 560, "ratio": 1.1, "vo2_run": 50.1, "vo2_bike": 52.3}
dates = [(today + timedelta(days=i)).isoformat() for i in range(7)]
state["plan"] = {
    "generated_at": datetime.now(tz=None).astimezone().isoformat(timespec="seconds"), "model": "demo", "stale": False,
    "last_week_summary": "Five sessions last week: two runs, two rides and one strength session, about 6.5 h in total. Load sits slightly above your 28-day average.",
    "readiness_note": "HRV is back inside your balanced range and sleep was 7.1 h, so you're good for planned work today.",
    "today_adjustment": "",
    "fitness_note": "Load ramps about 7% this week, with one quality run and one tempo ride, and the strength work placed away from the key sessions.",
    "days": [
        {"date": dates[0], "type": "weights", "session": "Lower body strength", "detail": "Heavy squat pattern, then easy hinge work. Keep tomorrow's run easy.", "focus": "Lower body",
         "exercises": [{"name": "Back squat", "sets": 4, "reps": "5", "note": "RPE 8"}, {"name": "Romanian deadlift", "sets": 3, "reps": "8", "note": ""},
                       {"name": "Walking lunge", "sets": 3, "reps": "10/leg", "note": ""}, {"name": "Calf raise", "sets": 3, "reps": "12", "note": ""}]},
        {"date": dates[1], "type": "run", "session": "Easy aerobic run", "detail": "Conversational pace, flat route.",
         "structure": [{"kind": "SteadyState", "duration": 2700, "power": 0.7}],
         "runPlan": {"skipWarmupCooldown": True, "warmup": None, "cooldown": None, "main": {"kind": "Steady", "description": "Easy Z2 run", "pace_low": "5:50", "pace_high": "6:20", "duration_min": 45}}},
        {"date": dates[2], "type": "bike", "session": "Sweet spot 3x12", "detail": "Zwift: three 12 minute blocks just under threshold.",
         "structure": [{"kind": "Warmup", "duration": 600, "powerLow": 0.5, "powerHigh": 0.75}, {"kind": "Intervals", "repeat": 3, "onDuration": 720, "onPower": 0.9, "offDuration": 300, "offPower": 0.55},
                       {"kind": "Cooldown", "duration": 600, "powerLow": 0.6, "powerHigh": 0.4}]},
        {"date": dates[3], "type": "rest", "session": "Rest day", "detail": "Full rest, optional 20 minute walk."},
        {"date": dates[4], "type": "run", "session": "Threshold intervals", "detail": "4 x 6 minutes at threshold with easy jogging between.",
         "structure": [{"kind": "Warmup", "duration": 900, "powerLow": 0.6, "powerHigh": 0.8}, {"kind": "Intervals", "repeat": 4, "onDuration": 360, "onPower": 1.0, "offDuration": 180, "offPower": 0.6},
                       {"kind": "Cooldown", "duration": 600, "powerLow": 0.7, "powerHigh": 0.5}],
         "runPlan": {"skipWarmupCooldown": False, "warmup": {"pace_low": "6:00", "pace_high": "6:30", "duration_min": 15},
                     "main": {"kind": "Intervals", "description": "Threshold repeats", "repeat": 4, "active_pace_low": "4:40", "active_pace_high": "4:50", "active_duration_min": 6, "rest_pace_low": "6:10", "rest_pace_high": "6:40", "rest_duration_min": 3},
                     "cooldown": {"pace_low": "6:10", "pace_high": "6:40", "duration_min": 10}}},
        {"date": dates[5], "type": "weights", "session": "Upper body strength", "detail": "Push and pull, short session before the long ride.", "focus": "Upper body",
         "exercises": [{"name": "Bench press", "sets": 4, "reps": "6", "note": ""}, {"name": "Barbell row", "sets": 4, "reps": "8", "note": ""}, {"name": "Overhead press", "sets": 3, "reps": "8", "note": ""}]},
        {"date": dates[6], "type": "bike", "session": "Long endurance ride", "detail": "Steady aerobic ride, fuel every 30 minutes.",
         "structure": [{"kind": "Warmup", "duration": 600, "powerLow": 0.5, "powerHigh": 0.65}, {"kind": "SteadyState", "duration": 7200, "power": 0.65}, {"kind": "Cooldown", "duration": 600, "powerLow": 0.6, "powerHigh": 0.4}]},
    ],
}
state["meta"]["sync"] = {"at": datetime.utcnow().isoformat(timespec="seconds") + "Z", "failures": {}}
save_state(state)
print("demo state written:", len(state["activities"]), "activities")
