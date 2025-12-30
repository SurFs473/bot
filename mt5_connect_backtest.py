from flask import Flask, request, jsonify
import MetaTrader5 as mt5
from datetime import datetime, timezone

app = Flask(__name__)

TF_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}

def ensure_mt5():
    if mt5.initialize():
        return True, None
    return False, mt5.last_error()

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})

@app.route("/connect", methods=["POST"])
def connect():
    ok, err = ensure_mt5()
    if not ok:
        return jsonify({"connected": False, "error": err}), 500
    ai = mt5.account_info()._asdict() if mt5.account_info() else None
    return jsonify({"connected": True, "account": ai})

@app.route("/shutdown", methods=["POST"])
def shutdown():
    mt5.shutdown()
    return jsonify({"ok": True})

@app.route("/rates_range", methods=["POST"])
def rates_range():
    ok, err = ensure_mt5()
    if not ok:
        return jsonify({"error": "mt5.initialize failed", "last_error": err}), 500

    data = request.get_json(force=True)
    symbol = data["symbol"]

    tf = data.get("timeframe", "M1")
    timeframe = TF_MAP.get(tf)
    if timeframe is None:
        return jsonify({"error": "bad timeframe", "tf": tf, "allowed": list(TF_MAP.keys())}), 400

    time_from = int(data["time_from"])
    time_to = int(data["time_to"])

    dt_from = datetime.fromtimestamp(time_from, tz=timezone.utc)
    dt_to   = datetime.fromtimestamp(time_to,   tz=timezone.utc)

    if dt_from >= dt_to:
        return jsonify({"error": "invalid time range", "dt_from": dt_from.isoformat(), "dt_to": dt_to.isoformat()}), 400

    if not mt5.symbol_select(symbol, True):
        return jsonify({"error": "symbol_select failed", "last_error": mt5.last_error(), "symbol": symbol}), 400

    if mt5.symbol_info(symbol) is None:
        return jsonify({"error": "symbol_info is None", "last_error": mt5.last_error(), "symbol": symbol}), 400

    rates = mt5.copy_rates_range(symbol, timeframe, dt_from, dt_to)
    if rates is None:
        return jsonify({
            "error": "copy_rates_range failed",
            "last_error": mt5.last_error(),
            "symbol": symbol,
            "tf": tf,
            "dt_from": dt_from.isoformat(),
            "dt_to": dt_to.isoformat()
        }), 400

    # MT5 returns numpy array -> list
    return jsonify({"rates": [r.tolist() for r in rates]})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5005)
