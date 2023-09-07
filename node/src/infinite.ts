import "dotenv/config";
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
  OrderResponseFull,
  generateNewOrderId,
  isWsFormattedTrade,
  WsMessageTradeFormatted,
  isWsAggTradeFormatted,
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
import { uuidv7 } from "uuidv7";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import got from "got";
import { List } from "immutable";
import fs from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { format } from "date-fns";
import closeWithGrace from "close-with-grace";
import { fileURLToPath } from "url";

const pythonClient = got.extend({
  agent: {
    http: new HttpAgent({
      keepAlive: true,
    }),
    https: new HttpsAgent({
      keepAlive: true,
    }),
  },
});

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

// Memory leak here, hope it wont be that bad
const customIdToLevel = new Map<string, number>();

function parseCustomId(...ids: string[]) {
  for (const id of ids) {
    if (customIdToLevel.has(id)) {
      return {
        id,
        level: customIdToLevel.get(id)!,
      };
    }
  }

  return undefined;
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
  api_key: process.env.BINANCE_KEY,
  api_secret: process.env.BINANCE_SECRET,
});

const binanceSocketClient = new WebsocketClient(
  {
    api_key: process.env.BINANCE_KEY,
    api_secret: process.env.BINANCE_SECRET,
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

async function createOrderAtLevel({
  price,
  side,
  quantity,
  level,
}: {
  price: Decimal;
  side: OrderSide;
  quantity: Decimal;
  level: number;
}) {
  let runawayCounter = 0;
  while (true) {
    const buyQuantity = quantity.toDecimalPlaces(5, Decimal.ROUND_DOWN);
    const customId = generateNewOrderId("spot");
    customIdToLevel.set(customId, level);

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error("Runaway loop detected in createOrderAtLevel");
    }

    try {
      console.debug(
        "Creating",
        side,
        "order at level",
        level,
        "@",
        price,
        customId
      );

      const resp = await binanceClient.marginAccountNewOrder({
        symbol: "BTCTUSD",
        side,
        type: "LIMIT",
        quantity: buyQuantity.toNumber(),
        price: price.toNumber(),
        isIsolated: "FALSE",
        timeInForce: "GTC",
        newClientOrderId: customId,
        newOrderRespType: "FULL",
      });

      return resp;
    } catch (err) {
      if ((err as any).code === -1021) {
        console.log(
          "Failed to place order, timestamp for this request is outside of the recvWindow. Retrying."
        );

        continue;
      } else {
        console.error(
          "Failed to place order",
          {
            price,
            side,
            quantity: buyQuantity,
            level,
          },
          err
        );

        throw err;
      }
    }
  }
}

async function createSellWithSLAtLevel({
  price,
  slPrice,
  quantity,
  level,
  slLevel,
}: {
  price: Decimal;
  slPrice: Decimal;
  quantity: Decimal;
  level: number;
  slLevel: number;
}) {
  let runawayCounter = 0;
  const buyQuantity = quantity.toDecimalPlaces(5, Decimal.ROUND_DOWN);

  while (true) {
    const customId = generateNewOrderId("spot");
    customIdToLevel.set(customId, level);

    const slCustomId = generateNewOrderId("spot");
    customIdToLevel.set(slCustomId, slLevel);

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error("Runaway loop detected in createOrderAtLevel");
    }

    try {
      console.debug(
        "Creating OCO",
        "order (",
        level,
        "@",
        price,
        customId,
        ") sl (",
        slLevel,
        slPrice,
        slCustomId,
        ")"
      );

      const resp = await binanceClient.marginAccountNewOCO({
        symbol: "BTCTUSD",
        side: "SELL",
        quantity: buyQuantity.toNumber(),
        price: price.toNumber(),
        stopPrice: slPrice.toNumber(),
        isIsolated: "FALSE",
        limitClientOrderId: customId,
        stopClientOrderId: customId,
      });

      return resp;
    } catch (err) {
      if ((err as any).code === -1021) {
        console.log(
          "Failed to place order, timestamp for this request is outside of the recvWindow. Retrying."
        );

        continue;
      } else {
        console.error(
          "Failed to place OCO SELL order",
          {
            price,
            slPrice,
            quantity: buyQuantity,
            level,
            slLevel,
          },
          err
        );

        throw err;
      }
    }
  }
}

async function cancelOrder(order: Order) {
  console.log(
    "Closing",
    order.side,
    "order",
    order.level,
    "@",
    order.price,
    order.customId
  );

  try {
    await binanceClient.marginAccountCancelOrder({
      isIsolated: "FALSE",
      symbol: "BTCTUSD",
      orderId: order.id,
    });
  } catch (err) {
    console.error("Failed to cancel order", order, err);

    throw err;
  }
}

async function replaceBuyOrder({
  newLevel,
  newPrice,
  lastOrder,
}: {
  lastOrder: Order;
  newLevel: number;
  newPrice: Decimal;
}) {
  try {
    console.log(
      "Replace BUY order",
      lastOrder.level,
      "@",
      lastOrder.price,
      "with",
      newLevel,
      "@",
      newPrice,
      lastOrder.customId
    );

    await cancelOrder(lastOrder);
    return await createOrderAtLevel({
      level: newLevel,
      price: newPrice,
      quantity: lastOrder.quantity,
      side: "BUY",
    });
  } catch (err) {
    console.error(
      "Error trying to replace buy order",
      {
        originalLevel: lastOrder.level,
        newLevel,
        originalPrice: lastOrder.price,
        newPrice,
      },
      err
    );

    throw err;
  }
}

async function liquidateSellToCreateBuy({
  newLevel,
  newPrice,
  sellOrder,
}: {
  sellOrder: Order;
  newLevel: number;
  newPrice: Decimal;
}) {
  try {
    console.log(
      "Liquidate SELL order",
      sellOrder.level,
      "@",
      sellOrder.price,
      "and replace with",
      newLevel,
      "@",
      newPrice,
      sellOrder.customId
    );

    await cancelOrder(sellOrder);
    const resp = await binanceClient.marginAccountNewOrder({
      symbol: "BTCTUSD",
      side: "SELL",
      type: "MARKET",
      quantity: sellOrder.quantity
        .toDecimalPlaces(5, Decimal.ROUND_DOWN)
        .toNumber(),
      newOrderRespType: "FULL",
    });

    const filledQuoteQty = new Decimal(
      (resp as OrderResponseFull).cummulativeQuoteQty
    );

    return await createOrderAtLevel({
      level: newLevel,
      price: newPrice,
      quantity: filledQuoteQty
        .div(newPrice)
        .toDecimalPlaces(5, Decimal.ROUND_DOWN),
      side: "BUY",
    });
  } catch (err) {
    console.error(
      "Error trying to liquidate sell order to create buy order",
      {
        originalLevel: sellOrder.level,
        newLevel,
        originalPrice: sellOrder.price,
        newPrice,
      },
      err
    );

    throw err;
  }
}

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBalance() {
  console.info("Refetching balance");

  try {
    const data = await binanceClient.queryCrossMarginAccountDetails();

    const balances = Object.fromEntries(
      data.userAssets.map((x) => [
        x.asset,
        {
          free: new Decimal(x.free),
          locked: new Decimal(x.locked),
        },
      ])
    );

    return {
      btc: balances["BTC"],
      tusd: balances["TUSD"],
    };
  } catch (err) {
    console.error("Failed to fetch balance", err);
    throw err;
  }
}

async function closeAll() {
  try {
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
    } else {
      console.log("No open orders to close");
    }

    let balances = await fetchBalance();
    while (balances.btc.locked.gt(0.0003)) {
      balances = await fetchBalance();
      await delay(100);
    }

    if (balances.btc.free.gt(0.0003)) {
      console.info("Selling off BTC balance");

      await binanceClient.marginAccountNewOrder({
        symbol: "BTCTUSD",
        side: "SELL",
        type: "MARKET",
        quantity: balances.btc.free.toNumber(),
        newOrderRespType: "FULL",
      });
    } else {
      console.log("Not enough BTC to sell");
    }

    console.log("Closed");
  } catch (err) {
    console.error("Failed to close all", err);
    throw err;
  }
}

async function keepUpdatingSettingsFromAPI(
  dispatch: (action: Action) => void,
  abort: AbortSignal
) {
  try {
    while (abort.aborted === false) {
      const resp = await pythonClient.get<{
        level_size: number;
        level_size_relative: number;
        trades: number;
        relevant_trades: number;
        first_trade: string;
        first_relevant_trade: string;
      }>(process.env.PYTHON_API || "http://127.0.0.1:8000", {
        throwHttpErrors: false,
        responseType: "json",
        retry: {
          limit: 10,
          statusCodes: [503],
          calculateDelay: () => 250,
        },
      });

      if (resp.statusCode !== 200) {
        console.log("Failed to fetch settings", resp.statusCode, resp.body);
        await delay(250);
        continue;
      }

      if (abort.aborted) {
        break;
      }

      if (resp.body.level_size && resp.body.level_size > 0) {
        dispatch({
          type: "updateSettings",
          payload: {
            levelSize: resp.body.level_size,
          },
        });
      }

      await delay(250);
    }

    console.info("Stopped updating settings from API");
  } catch (err) {
    console.error("Error while updating settings from API", err);
    throw err;
  }
}

interface WsAction {
  readonly type: "ws";
  readonly payload: WsFormattedMessage;
}

interface UpdateSettingsAction {
  readonly type: "updateSettings";
  readonly payload: {
    readonly levelSize: number;
  };
}

interface UpdateBalance {
  readonly type: "updateBalance";
  readonly payload: Awaited<ReturnType<typeof fetchBalance>>;
}

type Action = WsAction | UpdateSettingsAction | UpdateBalance;

interface Balance {
  readonly free: Decimal;
  readonly locked: Decimal;
}

interface Order {
  readonly side: OrderSide;
  readonly status: OrderStatus;
  readonly id: number;
  readonly customId: string;
  readonly level: number;
  readonly price: Decimal;
  readonly quantity: Decimal;
  readonly isCancelling?: boolean;
}

interface State {
  readonly levelSizeQuote?: Decimal;
  readonly currentLevelPrice?: Decimal;
  readonly currentLevelIndex: number;
  readonly buyLevels: ReadonlyArray<number>;
  readonly sellLevels: ReadonlyArray<number>;
  readonly targetTotalLevels: number;
  readonly targetMinBuyLevels: number;

  readonly tusd?: Balance;
  readonly btc?: Balance;
  readonly openOrders: Record<string, Order>;
  readonly orderBook?: {
    readonly bid: Decimal;
    readonly ask: Decimal;
  };
  readonly lastTrade?: {
    id: number;
    price: Decimal;
  };
}

function isStateInitialized(state: State): state is Required<State> {
  return !!(
    state.levelSizeQuote &&
    state.currentLevelPrice &&
    state.tusd &&
    state.btc &&
    state.lastTrade
  );
}

interface ReducerContext {
  promise<TParam extends readonly unknown[]>(
    name: string,
    generator: (...parameters: [...TParam]) => Promise<unknown>,
    ...parameters: TParam
  ): void;
  dispatch(action: Action): void;
}

function updateBalances(
  data: WsMessageSpotOutboundAccountPositionFormatted,
  state: State,
  ctx: ReducerContext
): State {
  globalStats.record([
    {
      measure: measurementOutboundAccountPosition,
      value: Date.now() - data.lastAccountUpdateTime,
    },
  ]);

  const balances = Object.fromEntries(
    data.balances.map((x) => [
      x.asset,
      {
        free: new Decimal(x.availableBalance),
        locked: new Decimal(x.onOrderBalance),
      },
    ])
  );

  return {
    ...state,
    btc: "BTC" in balances ? balances["BTC"] : state.btc,
    tusd: "TUSD" in balances ? balances["TUSD"] : state.tusd,
  };
}

function updateOrder(
  data: WsMessageSpotUserDataExecutionReportEventFormatted,
  state: State,
  ctx: ReducerContext
): State {
  let { openOrders, buyLevels, sellLevels } = state;

  globalStats.record([
    {
      measure: measurementExecutionReport,
      value: Date.now() - data.tradeTime,
    },
  ]);

  const customId = parseCustomId(
    data.originalClientOrderId,
    data.newClientOrderId
  );

  if (
    data.orderStatus === "FILLED" ||
    data.orderStatus === "CANCELED" ||
    data.orderStatus === "EXPIRED" ||
    data.orderStatus === "REJECTED" ||
    data.orderStatus === "PENDING_CANCEL"
  ) {
    openOrders = Object.fromEntries(
      Object.entries(state.openOrders).filter(
        ([key, value]) => key !== data.orderId.toString()
      )
    );

    if (customId && data.side === "BUY") {
      buyLevels = buyLevels.filter((x) => x !== customId.level);
    } else if (customId && data.side === "SELL") {
      sellLevels = sellLevels.filter((x) => x !== customId.level);
    }
  } else if (
    (data.orderType === "LIMIT" || data.orderType === "LIMIT_MAKER") &&
    customId
  ) {
    openOrders = {
      ...state.openOrders,
      [data.orderId.toString()]: {
        side: data.side,
        status: data.orderStatus,
        id: data.orderId,
        price: new Decimal(data.price),
        level: customId.level,
        quantity: new Decimal(data.quantity),
        customId: customId.id,
      },
    };
  }

  return { ...state, openOrders, buyLevels, sellLevels };
}

function replaceFilledOrder(
  data: WsMessageSpotUserDataExecutionReportEventFormatted,
  state: State &
    Required<Pick<State, "levelSizeQuote" | "currentLevelPrice" | "lastTrade">>,
  { promise }: ReducerContext
): State {
  const customId = parseCustomId(
    data.originalClientOrderId,
    data.newClientOrderId
  );

  if (!customId) {
    return state;
  }

  const price = new Decimal(data.price);

  console.debug(
    "Filled",
    data.side,
    "order at level",
    customId.level,
    "@",
    price,
    customId.id
  );

  const filled = {
    side: data.side,
    status: data.orderStatus,
    id: data.orderId,
    price: new Decimal(data.price),
    quantity: new Decimal(Math.max(data.quantity, data.accumulatedQuantity)),
    quoteQuantity: new Decimal(
      Math.max(data.orderQuoteQty, data.cummulativeQuoteAssetTransactedQty)
    ),
    level: customId.level,
  };

  if (filled.side === "BUY") {
    const level = getNextAvailableLevel(state, "SELL");

    promise("createOrderAtLevel", createOrderAtLevel, {
      price: level.price,
      side: "SELL",
      level: level.level,
      quantity: filled.quantity,
    });

    // promise("createSellWithSLAtLevel", createSellWithSLAtLevel, {
    //   price: level.price,
    //   slLevel: slLevel,
    //   slPrice: slPrice,
    //   level: level.level,
    //   quantity: filled.quantity,
    // });

    return {
      ...state,
      buyLevels: state.buyLevels.filter((x) => x !== level.level),
      sellLevels: state.sellLevels.concat(level.level),
    };
  } else {
    const level = getNextAvailableLevel(state, "BUY");

    promise("createOrderAtLevel", createOrderAtLevel, {
      price: level.price,
      side: "BUY",
      level: level.level,
      quantity: filled.quoteQuantity.div(level.price),
    });

    return {
      ...state,
      buyLevels: state.buyLevels.concat(level.level),
      sellLevels: state.sellLevels.filter((x) => x !== level.level),
    };
  }
}

function getNextAvailableLevel(
  state: Required<
    Pick<
      State,
      | "currentLevelPrice"
      | "currentLevelIndex"
      | "levelSizeQuote"
      | "buyLevels"
      | "sellLevels"
    >
  >,
  type: "BUY" | "SELL"
) {
  let { currentLevelPrice, currentLevelIndex, levelSizeQuote } = state;

  if (type === "BUY") {
    const buyLevels = new Set(state.buyLevels);

    let runawayCounter = 0;
    while (true) {
      currentLevelPrice = currentLevelPrice.sub(levelSizeQuote);
      currentLevelIndex -= 1;

      if (!buyLevels.has(currentLevelIndex)) {
        return {
          price: currentLevelPrice,
          level: currentLevelIndex,
        };
      }

      runawayCounter += 1;
      if (runawayCounter > 100) {
        console.log({
          currentLevelPrice,
          currentLevelIndex,
          levelSizeQuote,
          buyLevels,
          state,
        });
        throw new Error("Runaway loop detected in getNextAvailableLevel BUY");
      }
    }
  } else {
    const sellLevels = new Set(state.sellLevels);

    let runawayCounter = 0;
    while (true) {
      currentLevelPrice = currentLevelPrice.add(levelSizeQuote);
      currentLevelIndex += 1;

      if (!sellLevels.has(currentLevelIndex)) {
        return {
          price: currentLevelPrice,
          level: currentLevelIndex,
        };
      }

      runawayCounter += 1;
      if (runawayCounter > 100) {
        console.log({
          currentLevelPrice,
          currentLevelIndex,
          levelSizeQuote,
          sellLevels,
          state,
        });
        throw new Error("Runaway loop detected in getNextAvailableLevel SELL");
      }
    }
  }
}

function initializeBuyOrders(
  state: State &
    Required<
      Pick<State, "levelSizeQuote" | "currentLevelPrice" | "lastTrade" | "tusd">
    >,
  { promise }: ReducerContext
): State {
  let { buyLevels } = state;

  const levelsToCreate =
    state.targetTotalLevels - state.buyLevels.length - state.sellLevels.length;

  const levelQuantityQuote = state.tusd.free.times(0.8).div(levelsToCreate);

  console.log(
    "Creating",
    levelsToCreate,
    "buy levels with quote",
    levelQuantityQuote
  );

  for (let i = 0; i < levelsToCreate; i++) {
    const level = getNextAvailableLevel(
      {
        ...state,
        buyLevels,
      },
      "BUY"
    );

    promise("createOrderAtLevel", createOrderAtLevel, {
      level: level.level,
      price: level.price,
      quantity: levelQuantityQuote.div(level.price),
      side: "BUY",
    });

    buyLevels = buyLevels.concat(level.level);
  }

  console.log("Initialized");

  return {
    ...state,
    buyLevels,
  };
}

function updateBuyOrderPositions(
  state: State &
    Required<Pick<State, "levelSizeQuote" | "currentLevelPrice" | "lastTrade">>,
  { promise }: ReducerContext
): State {
  let { openOrders, buyLevels } = state;

  if (
    state.sellLevels.length > 0 ||
    state.buyLevels.length < state.targetTotalLevels
  ) {
    return state;
  }

  if (state.buyLevels.length > state.targetTotalLevels) {
    console.log("Invalid levels in state", state);
    throw new Error("Invalid number of levels in state");
  }

  let runawayCounter = 0;
  while (true) {
    const lastBuyOrder = Object.values(openOrders)
      .filter((x) => !x.isCancelling)
      .sort((a, b) => a.level - b.level)[0];

    const nextBuyLevel = getNextAvailableLevel(
      {
        ...state,
        buyLevels,
      },
      "BUY"
    );

    if (!lastBuyOrder || nextBuyLevel.price.lt(lastBuyOrder.price)) {
      break;
    }

    openOrders = {
      ...openOrders,
      [lastBuyOrder.id.toString()]: {
        ...lastBuyOrder,
        isCancelling: true,
      },
    };

    buyLevels = buyLevels
      .filter((x) => x !== lastBuyOrder.level)
      .concat(nextBuyLevel.level);

    promise("replaceBuyOrder", replaceBuyOrder, {
      newLevel: nextBuyLevel.level,
      newPrice: nextBuyLevel.price,
      lastOrder: lastBuyOrder,
    });

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error("Runaway loop detected in updateBuyOrderPositions");
    }
  }

  return {
    ...state,
    buyLevels,
    openOrders,
  };
}

/**
 * Liquidates upper most sell if not enough buy levels
 */
function ensureMinBuyLevels(
  state: State &
    Required<Pick<State, "levelSizeQuote" | "currentLevelPrice" | "lastTrade">>,
  { promise }: ReducerContext
): State {
  let { buyLevels, sellLevels, openOrders } = state;

  let runawayCounter = 0;
  while (
    buyLevels.length <= state.targetTotalLevels &&
    buyLevels.length < state.targetMinBuyLevels
  ) {
    const lastSellOrder = Object.values(openOrders)
      .filter((x) => x.side === "SELL" && !x.isCancelling)
      .sort((a, b) => b.level - a.level)[0];

    if (!lastSellOrder) {
      console.log("No upper most sell order found to replace");
      break;
    }

    const nextBuyLevel = getNextAvailableLevel(
      {
        ...state,
        buyLevels,
        sellLevels,
      },
      "BUY"
    );

    openOrders = {
      ...openOrders,
      [lastSellOrder.id.toString()]: {
        ...lastSellOrder,
        isCancelling: true,
      },
    };

    buyLevels = buyLevels.concat(nextBuyLevel.level);
    sellLevels = sellLevels.filter((x) => x !== lastSellOrder.level);

    promise("liquidateSellToCreateBuy", liquidateSellToCreateBuy, {
      newLevel: nextBuyLevel.level,
      newPrice: nextBuyLevel.price,
      sellOrder: lastSellOrder,
    });

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error("Runaway loop detected in ensureMinBuyLevels");
    }
  }

  return { ...state, buyLevels, sellLevels, openOrders };
}

function updateLastTrade(
  action: {
    price: Decimal;
    id: number;
  },
  state: State,
  ctx: ReducerContext
): State {
  return state.lastTrade && action.id < state.lastTrade.id
    ? state
    : {
        ...state,
        lastTrade: action,
        currentLevelPrice: state.currentLevelPrice || action.price,
      };
}

function updateCurrentIndex(
  action: {
    price: Decimal;
    id: number;
  },
  state: State,
  ctx: ReducerContext
): State {
  state = updateLastTrade(action, state, ctx);
  let { currentLevelIndex, currentLevelPrice, lastTrade, levelSizeQuote } =
    state;

  if (!currentLevelPrice || !lastTrade || !levelSizeQuote) {
    return state;
  }

  let runawayCounter = 0;
  while (lastTrade.price.gte(currentLevelPrice.add(levelSizeQuote))) {
    currentLevelIndex += 1;
    currentLevelPrice = currentLevelPrice.add(levelSizeQuote);
    console.log("Moving level up to", currentLevelIndex, currentLevelPrice);

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error(
        "Runaway loop detected in updateCurrentIndex Moving level up"
      );
    }
  }

  runawayCounter = 0;
  while (lastTrade.price.lte(currentLevelPrice.sub(levelSizeQuote))) {
    currentLevelIndex -= 1;
    currentLevelPrice = currentLevelPrice.sub(levelSizeQuote);
    console.log("Moving level down to", currentLevelIndex, currentLevelPrice);

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error(
        "Runaway loop detected in updateCurrentIndex Moving level down"
      );
    }
  }

  return {
    ...state,
    currentLevelIndex,
    currentLevelPrice,
  };
}

function validateState(state: State) {
  if (state.targetMinBuyLevels > state.targetTotalLevels) {
    throw new Error(
      "targetMinBuyLevels cannot be greater than targetTotalLevels"
    );
  }

  if (state.targetMinBuyLevels < 0) {
    throw new Error("targetMinBuyLevels cannot be negative");
  }

  if (state.targetTotalLevels < 0) {
    throw new Error("targetTotalLevels cannot be negative");
  }

  if (
    state.buyLevels.length + state.sellLevels.length >
    state.targetTotalLevels
  ) {
    throw new Error(
      "buyLevels.length + sellLevels.length cannot be greater than targetTotalLevels"
    );
  }

  if (
    state.sellLevels.length &&
    state.buyLevels.length < state.targetMinBuyLevels
  ) {
    throw new Error("buyLevels.length cannot be less than targetMinBuyLevels");
  }

  // TODO Breaks moving buy orders up
  //
  // if (
  //   state.buyLevels.length + state.sellLevels.length !==
  //   state.targetTotalLevels
  // ) {
  //   throw new Error(
  //     "buyLevels.length + sellLevels.length must be equal to targetTotalLevels"
  //   );
  // }
}

function reducer(action: Action, state: State, ctx: ReducerContext): State {
  if (
    action.type === "ws" &&
    isWsFormattedMarginOutboundAccountPosition(action.payload)
  ) {
    state = updateBalances(action.payload, state, ctx);
  } else if (
    action.type === "ws" &&
    isWsFormattedMarginUserDataExecutionReport(action.payload)
  ) {
    state = updateOrder(action.payload, state, ctx);

    if (action.payload.tradeId > 0 && action.payload.price > 0) {
      state = updateCurrentIndex(
        {
          price: new Decimal(action.payload.price),
          id: action.payload.tradeId,
        },
        state,
        ctx
      );
    }

    if (
      action.payload.orderStatus === "FILLED" &&
      action.payload.orderType !== "MARKET"
    ) {
      const customId = parseCustomId(
        action.payload.originalClientOrderId,
        action.payload.newClientOrderId
      );

      if (isStateInitialized(state) && customId) {
        state = replaceFilledOrder(action.payload, state, ctx);
      } else {
        console.warn("Cannot replace order", {
          customId,
          order: action.payload,
          state,
        });
      }
    }
  } else if (action.type === "ws" && isWsFormattedBookTicker(action.payload)) {
    state = {
      ...state,
      orderBook: {
        bid: new Decimal(action.payload.bidPrice),
        ask: new Decimal(action.payload.askPrice),
      },
    };
  } else if (action.type === "ws" && isWsAggTradeFormatted(action.payload)) {
    state = updateCurrentIndex(
      {
        price: new Decimal(action.payload.price),
        id: action.payload.lastTradeId,
      },
      state,
      ctx
    );
  } else if (action.type === "updateSettings") {
    state = {
      ...state,
      levelSizeQuote: new Decimal(action.payload.levelSize),
    };
  } else if (action.type === "updateBalance") {
    state = {
      ...state,
      tusd: action.payload.tusd,
      btc: action.payload.btc,
    };
  } else {
    console.warn("Unknown event", action);
  }

  if (
    state.buyLevels.length + state.sellLevels.length === 0 &&
    isStateInitialized(state)
  ) {
    state = initializeBuyOrders(state, ctx);
  }

  if (isStateInitialized(state)) {
    state = updateBuyOrderPositions(state, ctx);
  }

  if (isStateInitialized(state)) {
    state = ensureMinBuyLevels(state, ctx);
  }

  return state;
}

function createStore(abort: AbortSignal) {
  type InnerAction =
    | Action
    | {
        type: string;
        payload?: any;
      };

  let history = List<{
    timestamp: string;
    action?: InnerAction;
    state?: State;
  }>();

  let state: State = {
    currentLevelIndex: 0,
    targetMinBuyLevels: 3,
    targetTotalLevels: 10,
    buyLevels: [],
    sellLevels: [],
    openOrders: {},
  };

  function saveIntoHistory({
    state,
    action,
  }: {
    state?: State;
    action?: InnerAction;
  }) {
    history = history.withMutations((history) => {
      history.push({
        timestamp: new Date().toISOString(),
        action,
        state,
      });

      if (history.size > 1000) {
        history.shift();
      }
    });
  }

  saveIntoHistory({ state });

  async function handlePromises(
    promises: {
      name: string;
      generator: (...parameters: any[]) => Promise<unknown>;
      parameters: any[];
    }[],
    oldState: State,
    newState: State,
    action: Action
  ) {
    await Promise.all(
      promises.map(async ({ name, generator, parameters }) => {
        const id = uuidv7();
        try {
          saveIntoHistory({
            action: {
              type: `promise/${name}/started`,
              payload: {
                id,
                name,
                parameters,
                action,
                oldState,
                newState,
              },
            },
          });

          const resp = await generator(...parameters);

          saveIntoHistory({
            action: {
              type: `promise/${name}/finished`,
              payload: {
                id,
                name,
                parameters,
                resp,
              },
            },
          });
        } catch (error) {
          saveIntoHistory({
            action: {
              type: `promise/${name}/failed`,
              payload: {
                id,
                name,
                parameters,
                error,
              },
            },
          });

          console.error("Error while handling state change promise", {
            action,
            oldState,
            newState,
          });
          throw error;
        }
      })
    );
  }

  const pendingActions: Action[] = [];

  function dispatch(action: Action) {
    if (abort.aborted) {
      return;
    }

    pendingActions.push(action);
    process.nextTick(processNextAction);
  }

  async function processNextAction() {
    const action = pendingActions.shift();

    if (action === undefined || abort.aborted) {
      return;
    }

    const currentState = state;
    try {
      const promises: {
        name: string;
        generator: (...parameters: any[]) => Promise<unknown>;
        parameters: any[];
      }[] = [];

      const newState = reducer(action, currentState, {
        promise: (name, generator, ...parameters) =>
          promises.push({
            name,
            generator: generator as any,
            parameters: parameters as any,
          }),
        dispatch,
      });

      state = newState;

      if (isStateInitialized(newState)) {
        try {
          validateState(newState);
        } catch (err) {
          console.error("Invalid state", {
            err,
            action,
            currentState,
            newState,
          });
          throw err;
        }
      }

      if (JSON.stringify(newState) !== JSON.stringify(currentState)) {
        // Do not store orderbook changes because there is way too many of them
        for (const keyStr in newState) {
          const key: keyof State = keyStr as any;
          if (
            currentState[key] === newState[key] ||
            key === "orderBook" ||
            key === "lastTrade"
          ) {
            continue;
          }

          saveIntoHistory({ state: newState, action });
          break;
        }
      }

      await handlePromises(promises, currentState, newState, action);
    } catch (err) {
      console.error("Error while handling action", {
        err,
        action,
        state: currentState,
      });
      throw err;
    }
  }

  return {
    dispatch,
    getState() {
      return state;
    },
    getHistory() {
      return history.toArray();
    },
  };
}

async function saveLogs(store: ReturnType<typeof createStore>) {
  try {
    const logs = JSON.stringify(store.getHistory(), null, 2);

    const filename = resolve(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "logs",
        format(new Date(), "yyyy-MM-dd'T'HH-mm-ss'.json'")
      )
    );

    console.log("Wrting logs into", filename);

    try {
      await fs.mkdir(filename.replace(basename(filename), ""), {
        recursive: true,
      });
    } catch (err) {
      if ((err as any).code !== "EEXIST") {
        throw new Error(`Failed to create logs folder ${(err as any).message}`);
      }
    }

    await fs.writeFile(filename, logs, "utf-8");
  } catch (err) {
    console.log("Failed to save logs", err);
  }
}

function registerStatusHandler(store: ReturnType<typeof createStore>) {
  fastify.get("/", {
    async handler(request, reply) {
      const state = store.getState();
      return {
        equity:
          state.tusd &&
          state.btc &&
          state.lastTrade &&
          state.tusd.free
            .add(state.tusd.locked)
            .add(state.btc.free.times(state.lastTrade.price))
            .add(state.btc.locked.times(state.lastTrade.price)),
        state: state,
      };
    },
  });
}

async function main() {
  console.info("Starting");

  const abortController = new AbortController();
  const store = createStore(abortController.signal);

  registerStatusHandler(store);

  await fastify.listen({
    port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
    host: "0.0.0.0",
  });

  const close = closeWithGrace(
    {
      delay: 5000,
    },
    async ({ signal, err, manual }) => {
      if (err) {
        console.error("Error", err);
      }

      console.info("Stopping");
      try {
        abortController.abort();
        binanceSocketClient.closeAll();
        await Promise.all([closeAll(), saveLogs(store), fastify.close()]);
      } catch (err) {
        console.error("Error while closing", err);
      }

      console.log("All done");
    }
  );

  // setTimeout(() => {
  //   console.log("Periodic close");
  //   close.close();
  // }, 10 * 60 * 1000);

  await closeAll();

  keepUpdatingSettingsFromAPI(store.dispatch, abortController.signal);

  const balances = await fetchBalance();
  store.dispatch({
    type: "updateBalance",
    payload: balances,
  });

  binanceSocketClient.on("formattedMessage", (data) => {
    if (abortController.signal.aborted) {
      return;
    }

    store.dispatch({
      type: "ws",
      payload: data,
    });
  });

  await Promise.all([
    binanceSocketClient.subscribeMarginUserDataStream(),
    binanceSocketClient.subscribeAggregateTrades("BTCTUSD", "spot"),
  ]);

  console.info("Started");
}

main();
