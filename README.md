# Binance HFT Grid Trading Bot

> While this thing is profitable in backtests, I've never managed to make any actual money with it

This is an automated market making bot that profits from times of extreme volatility by placing and replacing orders in an infinite (moving) grid. When the price moves outside the current grid, orders furthest from the price are updated and positions are closed.
It makes money during sideways market with volatility higher than spread. It looses money during prolonged directional swings.

It makes extreme number of orders and trades so it needs an environment with 0 trading fees. In practice this means that it can only run on binance spot/margin during 0 fees promotions.

### Architecture

There is a Node.js HFT runtime/execution part and a Pyhon analysis settings server. The idea is that market analysis and stats settings are going to be available over an API and the runtime will periodically refresh them.

In practice the python part only really provides the number of levels and the level size based on some interpolated values that I've found to work during the backtest.

The Node runtime connects directly to the exchange using Binance websocket protocol and makes trades/orders as fast as possible.

Architectonically it is based on Redux/reducer pattern where there is an immutable state which gets modified by events from the exchange and then fires side effects (such as open/update exchange orders).
This is great for debugging because the whole aplication state can be logged after every event/action which makes debbuging easyish. Binance has many quirks and diagnosing timing issues is not fun.

I was worried about performance (speed) when processing hundreds of updates a second and basically allocating huge objects for each of them, but it worked out extremely quick.
I've however observed ~80ms to the exchange even when sitting in the same DC (AWS Tokio) which makes most of the performance discussions moot.
