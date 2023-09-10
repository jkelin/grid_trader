import { globalStats } from "@opencensus/core";
import {
  WsMessageSpotOutboundAccountPositionFormatted,
  WsMessageSpotUserDataExecutionReportEventFormatted,
  OrderSide,
  generateNewOrderId,
  isWsAggTradeFormatted,
  WsFormattedMessage,
  isWsFormattedUserDataEvent,
  WsMessageSpotUserDataEventFormatted,
  WsMessageBookTickerEventFormatted,
} from "binance";
import { Decimal } from "decimal.js";
import { isStateInitialized } from "./store.js";
import { State, ReducerContext, Order, Action } from "./types.js";
import {
  measurementExecutionReport,
  measurementOutboundAccountPosition,
  parseCustomId,
} from "./helpers.js";
import { cancelOrder, createOrderAtLevel } from "./client.js";

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

export function updateBalances(
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

export function updateOrders(
  data: WsMessageSpotUserDataExecutionReportEventFormatted,
  state: State,
  ctx: ReducerContext
): State {
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

  if (!customId) {
    return state;
  }

  switch (data.orderStatus) {
    case "NEW":
    case "PARTIALLY_FILLED":
      return {
        ...state,
        orders: state.orders
          .filter((x) => x.customId !== customId.id)
          .concat({
            side: data.side,
            status: data.orderStatus,
            id: data.orderId,
            price: new Decimal(data.price),
            level: customId.level,
            quantity: new Decimal(data.quantity),
            customId: customId.id,
            customState: "ACTIVE",
          })
          .toSorted((a, b) => a.level - b.level),
      };
    case "FILLED":
      console.log(
        "Order filled",
        data.side,
        customId.level,
        data.quantity,
        "@",
        data.price
      );
    default:
      return {
        ...state,
        orders: state.orders.filter((x) => x.customId !== customId.id),
      };
  }
}

export function getNextAvailableLevel(
  {
    currentLevelPrice,
    currentLevelIndex,
    levelSizeQuote,
    orders,
  }: Required<
    Pick<
      State,
      "currentLevelPrice" | "currentLevelIndex" | "levelSizeQuote" | "orders"
    >
  >,
  side: OrderSide
) {
  if (side === "BUY") {
    const buyLevels = orders
      .filter((x) => x.side === side && x.level < currentLevelIndex)
      .map((x) => x.level)
      .concat(currentLevelIndex)
      .toSorted((a, b) => b - a);

    for (let i = 0; i < buyLevels.length; i++) {
      currentLevelIndex -= 1;
      currentLevelPrice = currentLevelPrice.sub(levelSizeQuote);

      if (buyLevels[i] - 1 !== buyLevels[i + 1]) {
        break;
      }
    }
  } else {
    const sellLevels = orders
      .filter((x) => x.side === side && x.level > currentLevelIndex)
      .map((x) => x.level)
      .concat(currentLevelIndex)
      .toSorted((a, b) => a - b);

    for (let i = 0; i < sellLevels.length; i++) {
      currentLevelIndex += 1;
      currentLevelPrice = currentLevelPrice.add(levelSizeQuote);

      if (sellLevels[i] + 1 !== sellLevels[i + 1]) {
        break;
      }
    }
  }

  return {
    level: currentLevelIndex,
    price: currentLevelPrice,
  };
}

export function cancelOutdatedOrders(
  state: State &
    Required<Pick<State, "levelSizeQuote" | "currentLevelPrice" | "lastTrade">>,
  { promise }: ReducerContext,
  side: OrderSide
): State {
  function cancel(innerState: typeof state, order: Order) {
    promise("cancelOrder", cancelOrder, order);

    return {
      ...innerState,
      orders: innerState.orders.map((x) =>
        x.customId === order.customId
          ? {
              ...x,
              customState: "CANCELLING",
            }
          : x
      ),
    } satisfies State;
  }

  const orders = state.orders
    .filter((x) => x.side === side)
    .toSorted((a, b) =>
      side === "BUY" ? a.level - b.level : b.level - a.level
    );

  if (orders.length > 5) {
    const currentOrderLevels = new Set(
      orders.filter((x) => x.customState !== "CANCELLING").map((x) => x.level)
    );
    const missingOrderLevels = [...new Array(orders.length)]
      .map((_, i) =>
        side === "BUY"
          ? state.currentLevelIndex - i - 1
          : state.currentLevelIndex + i + 1
      )
      .filter((x) => !currentOrderLevels.has(x));

    const numberOfOrdersToCancel =
      missingOrderLevels.length -
      orders.filter((x) => x.customState === "CANCELLING").length;

    const ordersToCancel = orders
      .filter((x) => x.customState === "ACTIVE")
      .slice(0, numberOfOrdersToCancel);

    for (const order of ordersToCancel) {
      state = cancel(state, order);
    }
  }

  return state;
}

// // This does weird stuff with locked
// export function getFreeCapital({
//   orders,
//   btc,
//   tusd,
// }: Required<Pick<State, "orders" | "btc" | "tusd">>) {
//   const lockedBtc = orders
//     .filter((x) => x.side === "SELL")
//     .reduce((sum, x) => sum.add(x.quantity), new Decimal(0));

//   const lockedTusd = orders
//     .filter((x) => x.side === "BUY")
//     .reduce((sum, x) => sum.add(x.quantity.times(x.price)), new Decimal(0));

//   return {
//     btc: btc.free.plus(btc.locked).minus(Decimal.max(lockedBtc, btc.locked)),
//     tusd: tusd.free
//       .plus(tusd.locked)
//       .minus(Decimal.max(lockedTusd, tusd.locked)),
//   };
// }

export function getFreeCapital({
  orders,
  btc,
  tusd,
}: Required<Pick<State, "orders" | "btc" | "tusd">>) {
  const additionalLockedBtc = orders
    .filter((x) => x.side === "SELL" && x.customState === "CREATING")
    .reduce((sum, x) => sum.add(x.quantity), new Decimal(0));

  const additionalLockedTusd = orders
    .filter((x) => x.side === "BUY" && x.customState === "CREATING")
    .reduce((sum, x) => sum.add(x.quantity.times(x.price)), new Decimal(0));

  return {
    btc: btc.free.minus(additionalLockedBtc),
    tusd: tusd.free.minus(additionalLockedTusd),
  };
}

export function getTotalEquity({
  btc,
  tusd,
  lastTrade,
}: Required<Pick<State, "btc" | "tusd" | "lastTrade">>) {
  return tusd.free
    .add(tusd.locked)
    .add(btc.free.times(lastTrade.price))
    .add(btc.locked.times(lastTrade.price));
}

export function createMissingOrders(
  state: State &
    Required<
      Pick<
        State,
        "levelSizeQuote" | "currentLevelPrice" | "lastTrade" | "btc" | "tusd"
      >
    >,
  { promise }: ReducerContext
): State {
  function createOrder(
    side: OrderSide,
    price: Decimal,
    level: number,
    quantity: Decimal
  ) {
    const customId = generateNewOrderId("spot");

    promise("createOrderAtLevel", createOrderAtLevel, {
      level,
      price,
      quantity,
      side,
      customId,
    });

    return {
      side,
      price,
      level,
      quantity,
      customId: customId,
      customState: "CREATING",
    } satisfies Order;
  }

  let runawayCounter = 0;
  let lastState = state;
  do {
    lastState = state;

    const freeCapital = getFreeCapital(state);
    const totalEquity = getTotalEquity(state);
    let orderQuoteQuantity = totalEquity
      .times(0.95)
      .div(state.targetTotalLevels);
    let orderBaseQuantity = totalEquity
      .div(state.lastTrade.price)
      .times(0.95)
      .div(state.targetTotalLevels);

    if (freeCapital.tusd.gt(orderQuoteQuantity.times(0.95))) {
      const level = getNextAvailableLevel(state, "BUY");

      if (freeCapital.tusd.lte(orderQuoteQuantity.times(1.05))) {
        orderQuoteQuantity = freeCapital.tusd;
      }

      state = {
        ...state,
        orders: state.orders.concat(
          createOrder(
            "BUY",
            level.price,
            level.level,
            orderQuoteQuantity.div(level.price)
          )
        ),
      };
    }

    if (freeCapital.btc.gt(orderBaseQuantity)) {
      const level = getNextAvailableLevel(state, "SELL");

      if (freeCapital.btc.lte(orderBaseQuantity.times(1.05))) {
        orderBaseQuantity = freeCapital.btc;
      }

      state = {
        ...state,
        orders: state.orders.concat(
          createOrder("SELL", level.price, level.level, orderBaseQuantity)
        ),
      };
    }

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error("Runaway loop detected in createMissingOrders");
    }
  } while (lastState !== state);

  return state;
}

export function updateLastTrade(
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

export function updateCurrentIndex(
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

export function reducer(
  action: Action,
  state: State,
  ctx: ReducerContext
): State {
  if (
    action.type === "ws" &&
    isWsFormattedMarginOutboundAccountPosition(action.payload)
  ) {
    state = updateBalances(action.payload, state, ctx);
  } else if (
    action.type === "ws" &&
    isWsFormattedMarginUserDataExecutionReport(action.payload)
  ) {
    state = updateOrders(action.payload, state, ctx);

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

  if (isStateInitialized(state)) {
    state = cancelOutdatedOrders(state, ctx, "BUY");
  }
  if (isStateInitialized(state)) {
    state = cancelOutdatedOrders(state, ctx, "SELL");
  }

  if (
    state.orders.length < state.targetTotalLevels &&
    isStateInitialized(state)
  ) {
    state = createMissingOrders(state, ctx);
  }

  return state;
}
