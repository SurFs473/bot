// pip install MetaTrader5 pandas numpy
// pip install loguru
// pip install MetaTrader5 flask pandas
// npm install axios

za backtest runkash mt5_connect_backtest
za live mt5_connect_test

v momenta samo bot_51_winrate bi trqbvalo da raboti za live
test files backtest-orb15

notes::
4️⃣ spreadOk() ЛОГИЧЕСКИ Е СЛАБ
return !lastM1 || lastM1[6] == null || lastM1[6] <= MAX_SPREAD_POINTS;


Това значи:

ако spread == null → OK

ако lastM1 липсва → OK

❗ В реален трейдинг това е опасно.

✅ По-безопасно:
if (!lastM1) return false;
if (lastM1[6] == null) return false;
return lastM1[6] <= MAX_SPREAD_POINTS;

