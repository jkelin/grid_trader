# Binance High-Frequency Trading (HFT) Grid Trading Bot

> Disclaimer: While this bot has shown profitability in backtests, the author has not successfully generated actual profits with it in live trading.

This automated market-making bot is designed to capitalize on periods of extreme volatility by placing and replacing orders within an infinite (moving) grid. When the price moves outside the current grid, orders furthest from the price are updated, and positions are closed.

The bot is profitable during sideways markets with volatility higher than the spread. However, it tends to lose money during prolonged directional price movements.

Due to the extremely high number of orders and trades executed, this bot requires an environment with zero trading fees. In practice, this means it can only operate on Binance spot/margin markets during zero-fee promotions.

### Architecture

The system consists of two main components:
1. A Node.js HFT runtime/execution module
2. A Python analysis settings server

The concept is that market analysis and statistical settings are made available via an API, which the runtime periodically refreshes.

In practice, the Python component primarily provides the number of grid levels and the level size, based on interpolated values that have proven effective during backtesting.

The Node.js runtime establishes a direct connection to the exchange using the Binance WebSocket protocol, executing trades and orders as quickly as possible.

Architecturally, the system is based on the Redux/reducer pattern, featuring an immutable state that is modified by events from the exchange. These modifications then trigger side effects (such as opening or updating exchange orders).

This approach greatly facilitates debugging, as the entire application state can be logged after each event/action, making the diagnosis of issues relatively straightforward. Given Binance's numerous quirks, this is particularly helpful when troubleshooting timing-related problems.

Initially, there were concerns about performance (speed) when processing hundreds of updates per second and allocating large objects for each of them. However, the system has proven to be extremely quick in practice.

That said, the author has observed latencies of approximately 80ms to the exchange, even when operating within the same data center (AWS Tokyo). This significant latency renders most performance optimizations relatively insignificant in comparison.
