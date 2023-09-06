import {
  MainClient,
  WebsocketClient,
  isWsFormattedSpotOutboundAccountPosition,
  isWsFormattedUserDataEvent,
  isWsFormattedSpotUserDataExecutionReport,
  WsMessageSpotUserDataExecutionReportEventFormatted,
  WsFormattedMessage,
  WsMessageSpotUserDataEventFormatted,
  WsMessageSpotOutboundAccountPositionFormatted,
  OrderSide,
  OrderStatus,
  WsMessageBookTickerEventFormatted,
} from "binance";
import Fastify from "fastify";
import Decimal from "decimal.js";
import {
  globalStats,
  MeasureUnit,
  AggregationType,
  TagMap,
} from "@opencensus/core";
import { PrometheusStatsExporter } from "@opencensus/exporter-prometheus";
import AwesomeDebouncePromise from "awesome-debounce-promise";

const measurementExecutionReport = globalStats.createMeasureDouble(
  "latency/executionReport",
  MeasureUnit.MS,
  "Latency in MS for receiving executionReport over websocket"
);
const measurementOutboundAccountPosition = globalStats.createMeasureDouble(
  "latency/outboundAccountPosition",
  MeasureUnit.MS,
  "Latency in MS for receiving outboundAccountPosition over websocket"
);

export function isWsFormattedMarginUserDataEvent(
  data: WsFormattedMessage
): data is WsMessageSpotUserDataEventFormatted {
  return isWsFormattedUserDataEvent(data) && data.wsMarket.includes("margin");
}

export function isWsFormattedBookTicker(
  data: WsFormattedMessage
): data is WsMessageBookTickerEventFormatted {
  return (data as any).eventType === "bookTicker";
}

function isWsFormattedMarginUserDataExecutionReport(
  data: WsFormattedMessage
): data is WsMessageSpotUserDataExecutionReportEventFormatted {
  return (
    isWsFormattedMarginUserDataEvent(data) &&
    data.eventType === "executionReport"
  );
}

export function isWsFormattedMarginOutboundAccountPosition(
  data: WsFormattedMessage
): data is WsMessageSpotOutboundAccountPositionFormatted {
  return (
    isWsFormattedMarginUserDataEvent(data) &&
    data.eventType === "outboundAccountPosition"
  );
}

const fastify = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
});

const binanceClient = new MainClient({
  api_key: "wC4aWEM3sABQ9ocjP8AuHpIY57iduU6lP6ty4EMeF3R3juyYdfniOZQBvIyPNPJl",
  api_secret:
    "MVtfrnliPdS8LQFfr7BKEYAxoctmH24wgt5biFk8L8GPaVIfiZQhVOdNkH7K00vI",
});

const binanceSocketClient = new WebsocketClient(
  {
    api_key: "wC4aWEM3sABQ9ocjP8AuHpIY57iduU6lP6ty4EMeF3R3juyYdfniOZQBvIyPNPJl",
    api_secret:
      "MVtfrnliPdS8LQFfr7BKEYAxoctmH24wgt5biFk8L8GPaVIfiZQhVOdNkH7K00vI",
    beautify: true,
  }
  // console as any
);

binanceSocketClient.on("open", (data) => {
  console.info("ws connection opened");
});

binanceSocketClient.on("reconnecting", (data) => {
  console.debug("ws reconnecting");
});

binanceSocketClient.on("reconnected", (data) => {
  console.debug("ws reconnected");
});

const balances: Record<string, { free: Decimal; locked: Decimal }> = {};
const openOrders: Record<
  string,
  {
    side: OrderSide;
    orderStatus: OrderStatus;
    orderCreationTime: number;
    orderId: number;
    price: number;
  }
> = {};
let config: null | {
  gridLevels: Decimal[];
  levelQuantity: Decimal;
  stopLoss?: Decimal;
} = null;
let ticker: null | {
  bid: Decimal;
  ask: Decimal;
} = null;
let shuttingDown = false;
const pendingLevels = new Set<string>();

binanceSocketClient.on("formattedMessage", async (data) => {
  try {
    if (isWsFormattedMarginOutboundAccountPosition(data)) {
      globalStats.record([
        {
          measure: measurementOutboundAccountPosition,
          value: Date.now() - data.lastAccountUpdateTime,
        },
      ]);
      for (const asset of data.balances) {
        balances[asset.asset] = {
          free: new Decimal(asset.availableBalance),
          locked: new Decimal(asset.onOrderBalance),
        };
      }
    } else if (isWsFormattedMarginUserDataExecutionReport(data)) {
      globalStats.record([
        {
          measure: measurementExecutionReport,
          value: Date.now() - data.tradeTime,
        },
      ]);

      if (data.orderType === "LIMIT" || data.orderType === "LIMIT_MAKER") {
        openOrders[data.orderId] = {
          side: data.side,
          orderStatus: data.orderStatus,
          orderCreationTime: Date.now(),
          orderId: data.orderId,
          price: data.price,
        };

        if (
          data.orderStatus === "FILLED" ||
          data.orderStatus === "CANCELED" ||
          data.orderStatus === "EXPIRED" ||
          data.orderStatus === "REJECTED" ||
          data.orderStatus === "PENDING_CANCEL"
        ) {
          delete openOrders[data.orderId];
          const price = new Decimal(data.price);

          if (config && data.orderStatus === "FILLED") {
            console.debug("Order at level filled", data.side, "@", price);

            if (data.side === "BUY") {
              const nextLevel = config.gridLevels
                .filter((level) => level.gt(price))
                .sort((a, b) => a.cmp(b))[0];

              if (nextLevel) {
                await createOrderAtLevel(nextLevel, "SELL");
              }
            } else {
              const prevLevel = config.gridLevels
                .filter((level) => level.lt(price))
                .sort((a, b) => b.cmp(a))[0];

              if (prevLevel) {
                await createOrderAtLevel(prevLevel, "BUY");
              }
            }
          }
        }
      }
    } else if (isWsFormattedBookTicker(data)) {
      ticker = {
        bid: new Decimal(data.bidPrice),
        ask: new Decimal(data.askPrice),
      };
    } else {
      console.warn("unknown event: %o", data);
    }
  } catch (err) {
    console.error(
      "Error while handling formattedMessage",
      (err as Error).message,
      data
    );

    throw err;
  }
});

async function createOrderAtLevel(level: Decimal, side: OrderSide) {
  while (true) {
    try {
      if (!config) {
        return;
      }

      const price = level.toNumber();
      const quantity = config.levelQuantity.toNumber();

      console.debug("Creating order at level", side, "@", price);

      await binanceClient.marginAccountNewOrder({
        symbol: "BTCTUSD",
        side,
        type: "LIMIT",
        quantity,
        price,
        isIsolated: "FALSE",
        timeInForce: "GTC",
      });

      return;
    } catch (err) {
      if ((err as any).code === -1021) {
        console.log(
          "Failed to place order, timestamp for this request is outside of the recvWindow. Retrying."
        );

        continue;
      }

      console.error(
        "Failed to place order",
        {
          level,
          side,
        },
        err
      );

      throw err;
    }
  }
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function keepOrdersUpdated() {
  try {
    while (!shuttingDown) {
      if (!ticker || !config) {
        await delay(100);
        continue;
      }

      const { bid } = ticker;
      const { stopLoss } = config;

      if (stopLoss && ticker.bid.lt(stopLoss)) {
        console.info("Stop loss triggered", ticker.bid, "<", stopLoss);
        await closeAll();
        continue;
      }

      const previousLevel = config.gridLevels
        .filter((level) => level.lt(bid))
        .reverse()
        .slice(1, 6)
        .find((level) => pendingLevels.has(level.toString()));

      if (previousLevel) {
        pendingLevels.delete(previousLevel.toString());
        await createOrderAtLevel(previousLevel, "BUY");
        await delay(250);
      } else {
        await delay(10);
      }
    }
  } catch (err) {
    console.error("Error in keepOrdersUpdated", (err as Error).message);
    throw err;
  }
}

async function refetchBalance() {
  console.info("Refetching balance");
  const data = await binanceClient.queryCrossMarginAccountDetails();
  for (const asset of data.userAssets) {
    balances[asset.asset] = {
      free: new Decimal(asset.free),
      locked: new Decimal(asset.locked),
    };
  }
}

async function closeAll() {
  config = null;
  pendingLevels.clear();

  console.log("Close all");

  const openOrders = await binanceClient.queryMarginAccountOpenOrders({
    symbol: "BTCTUSD",
    isIsolated: "FALSE",
  });

  if (openOrders.length) {
    console.info("Cancelling open orders");
    await binanceClient.marginAccountCancelOpenOrders({
      symbol: "BTCTUSD",
      isIsolated: "FALSE",
    });

    do {
      await refetchBalance();
      await delay(100);
    } while (balances.BTC.locked.gt(0.0003) || balances.USDT.locked.gt(5));
  } else {
    console.log("No open orders to close");
  }

  if (balances.BTC.free.gt(0.0003)) {
    console.info("Selling off BTC balance");

    await binanceClient.marginAccountNewOrder({
      symbol: "BTCTUSD",
      side: "SELL",
      type: "MARKET",
      quantity: balances.BTC.free.toNumber(),
    });

    do {
      await refetchBalance();
      await delay(100);
    } while (balances.BTC.free.gt(0.0003));
  } else {
    console.log("Not enough BTC to sell");
  }
}

fastify.post<{
  Body: {
    gridLevels: number[];
    stopLoss?: number;
  };
}>("/config", {
  schema: {
    body: {
      type: "object",
      required: ["gridLevels"],
      properties: {
        gridLevels: {
          type: "array",
          items: { type: "number" },
        },
        stopLoss: {
          type: "number",
        },
      },
    },
  },
  async handler(request, reply) {
    await closeAll();

    const levels = [...request.body.gridLevels]
      .sort((a: number, b: number) => a - b)
      .map((x) => new Decimal(x));

    const levelUsd = balances.TUSD.free.times(0.8).div(levels.length);
    const levelQuantity = levelUsd.div(levels[0]).toDecimalPlaces(5);

    if (levelUsd.lt(5)) {
      return reply.status(400).send({
        error: "Not enough TUSD to create levels",
        detail: {
          total: balances.TUSD.free.toString(),
          useable: balances.TUSD.free.times(0.8).toString(),
          needed: levels.length * 5,
        },
      });
    }

    levels.forEach((x) => pendingLevels.add(x.toString()));
    config = {
      gridLevels: levels,
      levelQuantity,
      stopLoss: request.body.stopLoss
        ? new Decimal(request.body.stopLoss)
        : undefined,
    };

    console.log("Updated config to", config);

    return { status: "success" };
  },
});

fastify.post("/close", {
  async handler(request, reply) {
    await closeAll();

    console.log("Closed all positions");

    return { status: "success" };
  },
});

async function main() {
  console.info("Starting");
  await refetchBalance();
  await closeAll();

  const metricsExporter = new PrometheusStatsExporter({
    port: 3001,
    startServer: true,
  });

  const streams: any[] = [];

  try {
    void keepOrdersUpdated();

    streams.push(await binanceSocketClient.subscribeMarginUserDataStream());
    streams.push(
      await binanceSocketClient.subscribeSymbolBookTicker("BTCTUSD", "spot")
    );

    await fastify.listen({ port: 3000, host: "0.0.0.0" });

    console.info("Started");

    await waitForExit();
  } finally {
    console.info("Stopping");
    shuttingDown = true;
    await fastify.close();
    await new Promise<void>((resolve) => metricsExporter.stopServer(resolve));

    for (const stream of streams) {
      binanceSocketClient.closeWs(stream);
    }

    await closeAll();
  }

  console.info("All done");
  process.exit(0);
}

function waitForExit() {
  return new Promise<void>((resolve, reject) => {
    let closed = false;

    process.on("SIGINT", () => {
      if (closed) {
        return;
      }

      console.info("SIGINT");
      resolve();
      closed = true;
    });

    process.on("SIGQUIT", () => {
      if (closed) {
        return;
      }

      console.info("SIGQUIT");
      resolve();
      closed = true;
    });

    process.on("SIGTERM", () => {
      if (closed) {
        return;
      }

      console.info("SIGTERM");
      resolve();
      closed = true;
    });

    process.on("unhandledRejection", (reason, p) => {
      if (closed) {
        return;
      }

      console.error("Unhandled Rejection at Promise");
      reject(reason);
      closed = true;
    });

    process.on("uncaughtException", (err) => {
      if (closed) {
        return;
      }

      console.error("Uncaught Exception thrown");
      reject(err);
      closed = true;
    });
  });
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
