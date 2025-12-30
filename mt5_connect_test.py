from flask import Flask, request, jsonify
import MetaTrader5 as mt5

app = Flask(__name__)

# =========================
# TIMEFRAMES
# =========================

TF_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
}

# =========================
# BASIC
# =========================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})

@app.route("/connect", methods=["POST"])
def connect():
    if not mt5.initialize():
        return jsonify({"connected": False, "error": mt5.last_error()})
    acc = mt5.account_info()
    return jsonify({"connected": True, "account": acc._asdict() if acc else None})

@app.route("/shutdown", methods=["POST"])
def shutdown():
    mt5.shutdown()
    return jsonify({"ok": True})

# =========================
# ACCOUNT & SYMBOL INFO
# =========================

@app.route("/account", methods=["POST"])
def account():
    acc = mt5.account_info()
    if acc is None:
        return jsonify({"error": "account_info failed", "last_error": mt5.last_error()}), 400
    return jsonify({"account": acc._asdict()})

@app.route("/symbol_info", methods=["POST"])
def symbol_info():
    data = request.get_json(force=True)
    symbol = data["symbol"]

    info = mt5.symbol_info(symbol)
    if info is None:
        return jsonify({"error": "symbol_info failed", "last_error": mt5.last_error()}), 400

    return jsonify(info._asdict())

# =========================
# MARKET DATA
# =========================

@app.route("/rates", methods=["POST"])
def rates():
    data = request.get_json(force=True)
    symbol = data["symbol"]
    tf = data.get("timeframe", "M1")
    count = data.get("count", 300)

    timeframe = TF_MAP.get(tf)
    if timeframe is None:
        return jsonify({"error": f"bad timeframe {tf}"}), 400

    if not mt5.symbol_select(symbol, True):
        return jsonify({"error": "symbol_select failed", "last_error": mt5.last_error()}), 400

    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None:
        return jsonify({"error": "copy_rates_from_pos failed", "last_error": mt5.last_error()}), 400

    return jsonify({"rates": [r.tolist() for r in rates]})

@app.route("/tick", methods=["POST"])
def tick():
    data = request.get_json(force=True)
    symbol = data["symbol"]

    if not mt5.symbol_select(symbol, True):
        return jsonify({"error": "symbol_select failed", "last_error": mt5.last_error()}), 400

    t = mt5.symbol_info_tick(symbol)
    if t is None:
        return jsonify({"error": "symbol_info_tick failed", "last_error": mt5.last_error()}), 400

    return jsonify({"tick": t._asdict()})

# =========================
# ORDER
# =========================

@app.route("/order", methods=["POST"])
def order():
    d = request.get_json(force=True)

    if not mt5.symbol_select(d["symbol"], True):
        return jsonify({"error": "symbol_select failed", "last_error": mt5.last_error()}), 400

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": d["symbol"],
        "volume": float(d["volume"]),
        "type": int(d["type"]),
        "price": float(d["price"]),
        "sl": float(d.get("sl", 0.0)),
        "tp": float(d.get("tp", 0.0)),
        "deviation": int(d.get("deviation", 20)),
        "magic": int(d.get("magic", 0)),
        "comment": d.get("comment", "js-bot"),
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_FOK,
    }

    res = mt5.order_send(req)
    if res is None:
        return jsonify({"error": "order_send failed", "last_error": mt5.last_error()}), 400

    return jsonify({"result": res._asdict()})

# =========================
# RUN
# =========================

if __name__ == "__main__":
    print("### MT5 GATEWAY READY (WITH ACCOUNT & SYMBOL_INFO) ###")
    app.run(host="127.0.0.1", port=5005)
