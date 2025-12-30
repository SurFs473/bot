from flask import Flask, request, jsonify
import MetaTrader5 as mt5

app = Flask(__name__)

TF_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
}

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})

@app.route("/connect", methods=["POST"])
def connect():
    if mt5.initialize():
        ai = mt5.account_info()._asdict() if mt5.account_info() else None
        return jsonify({"connected": True, "account": ai})
    return jsonify({"connected": False, "error": mt5.last_error()})

@app.route("/shutdown", methods=["POST"])
def shutdown():
    mt5.shutdown()
    return jsonify({"ok": True})

@app.route("/rates", methods=["POST"])
def rates():
    data = request.get_json(force=True)
    symbol = data["symbol"]
    tf = data.get("timeframe", "M1")
    timeframe = TF_MAP.get(tf, mt5.TIMEFRAME_M1)
    count = data.get("count", 300)

    if not mt5.symbol_select(symbol, True):
        return jsonify({"error": "symbol_select failed", "last_error": mt5.last_error()}), 400

    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
    if rates is None:
        return jsonify({"error": "copy_rates_from_pos failed", "last_error": mt5.last_error()}), 400

    # return as JSON-safe list
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

@app.route("/order", methods=["POST"])
def order():
    data = request.get_json(force=True)
    symbol = data["symbol"]

    if not mt5.symbol_select(symbol, True):
        return jsonify({"error": "symbol_select failed", "last_error": mt5.last_error()}), 400

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(data["volume"]),
        "type": int(data["type"]),   # mt5.ORDER_TYPE_BUY / SELL
        "price": float(data["price"]),
        "sl": float(data.get("sl", 0.0)),
        "tp": float(data.get("tp", 0.0)),
        "deviation": int(data.get("deviation", 20)),
        "magic": int(data.get("magic", 50015002)),
        "comment": data.get("comment", "js-bot"),
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_FOK,
    }

    res = mt5.order_send(req)
    if res is None:
        return jsonify({"error": "order_send returned None", "last_error": mt5.last_error()}), 400
    return jsonify({"result": res._asdict()})

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5005)
