import uvicorn
from typing import Union
from fastapi import FastAPI, HTTPException
import ccxt.pro as ccxtpro
import asyncio
from fastapi import BackgroundTasks, FastAPI
from contextlib import asynccontextmanager
import pandas as pd
import numpy as np
from threading import Lock

trades_lock = Lock()
global_trades: pd.DataFrame = None


async def run_main():
    global global_trades

    exchange = ccxtpro.binance({"newUpdates": True})
    exchange.options["tradesLimit"] = 10000
    await exchange.watch_trades("BTC/FDUSD")

    trades = await exchange.fetch_trades("BTC/FDUSD", limit=10000)
    trades = pd.DataFrame(trades)
    trades["timestamp"] = pd.to_datetime(trades["timestamp"], unit="ms", utc=True)
    trades = trades.set_index("id")

    with trades_lock:
        global_trades = trades[["price", "amount", "timestamp"]]

    try:
        while True:
            trades = await exchange.watch_trades("BTC/FDUSD")

            with trades_lock:
                global_trades.loc[trades[-1]["id"]] = {
                    "price": trades[-1]["price"],
                    "amount": trades[-1]["amount"],
                    "timestamp": pd.Timestamp(
                        trades[-1]["timestamp"], unit="ms", tz="UTC"
                    ),
                }
                global_trades = global_trades[
                    global_trades.timestamp
                    > pd.Timestamp.now(tz="UTC") - pd.Timedelta("1T")
                ]
    finally:
        await exchange.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(run_main())
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/")
def read_root():
    global global_trades

    if global_trades is None:
        raise HTTPException(
            status_code=503,
            detail="Not yet initialized",
            headers={
                "Retry-After": (
                    pd.Timestamp.now(tz="UTC") + pd.Timedelta("250ms")
                ).isoformat()
            },
        )

    with trades_lock:
        trades = global_trades.copy()

    relevant_trades = trades[
        trades.timestamp > pd.Timestamp.now(tz="UTC") - pd.Timedelta("10s")
    ]

    level_size = (
        np.interp(
            relevant_trades.price.std(),
            np.geomspace(5, 50, 10),
            np.linspace(0.00005, 0.0004, 10),
        )
        * relevant_trades.price.iloc[-1]
    )

    return {
        "level_size": np.round(level_size, 2),
        "level_size_relative": np.round(level_size / relevant_trades.price.iloc[-1], 6),
        "trades": len(trades),
        "relevant_trades": len(relevant_trades),
        "first_trade": trades.timestamp.iloc[0],
        "first_relevant_trade": relevant_trades.timestamp.iloc[0],
    }
