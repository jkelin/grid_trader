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
  dheader,
  measurementExecutionReport,
  measurementOutboundAccountPosition,
  parseCustomId,
} from "./helpers.js";
import {
  cancelOrder,
  createOrderAtLevel,
  ignoreCancellationErrorOrderIds,
} from "./client.js";

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
    fdusd: "FDUSD" in balances ? balances["FDUSD"] : state.fdusd,
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
      const order = state.orders.find((x) => x.customId === customId.id);
      if (order && order.customState == "CREATING") {
        console.log(
          dheader(),
          "Order created",
          data.side,
          customId.level,
          "q:",
          data.quantity,
          "@",
          data.price,
          data.originalClientOrderId
        );

        if (order.side == "SELL") {
          state = {
            ...state,
            btc: state.btc
              ? {
                  ...state.btc,
                  free: state.btc.free.minus(data.quantity),
                  locked: state.btc.locked.plus(data.quantity),
                }
              : state.btc,
          };
        } else {
          state = {
            ...state,
            fdusd: state.fdusd
              ? {
                  ...state.fdusd,
                  free: state.fdusd.free.minus(data.quantity * data.price),
                  locked: state.fdusd.locked.plus(data.quantity * data.price),
                }
              : state.fdusd,
          };
        }
      }
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
        dheader(),
        "Order filled",
        data.side,
        customId.level,
        "q:",
        data.quantity,
        "@",
        data.price,
        data.originalClientOrderId
      );

      ignoreCancellationErrorOrderIds.add(data.orderId);
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
      orders
        // .filter((x) => x.customState !== "CANCELLING")
        .map((x) => x.level)
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

    if (numberOfOrdersToCancel > 0) {
      const ordersToCancel = orders
        .filter((x) => x.customState === "ACTIVE")
        .slice(0, numberOfOrdersToCancel);

      if (ordersToCancel.length) {
        console.log(
          dheader(),
          "Cancelling",
          side,
          "orders",
          ordersToCancel.map((x) => x.level),
          "because levels",
          missingOrderLevels,
          "are missing. Current levels:",
          [...currentOrderLevels].join(", ")
        );

        for (const order of ordersToCancel) {
          state = cancel(state, order);
        }
      }
    }
  }

  return state;
}

// // This does weird stuff with locked
// export function getFreeCapital({
//   orders,
//   btc,
//   fdusd,
// }: Required<Pick<State, "orders" | "btc" | "fdusd">>) {
//   const lockedBtc = orders
//     .filter((x) => x.side === "SELL")
//     .reduce((sum, x) => sum.add(x.quantity), new Decimal(0));

//   const lockedfdusd = orders
//     .filter((x) => x.side === "BUY")
//     .reduce((sum, x) => sum.add(x.quantity.times(x.price)), new Decimal(0));

//   return {
//     btc: btc.free.plus(btc.locked).minus(Decimal.max(lockedBtc, btc.locked)),
//     fdusd: fdusd.free
//       .plus(fdusd.locked)
//       .minus(Decimal.max(lockedfdusd, fdusd.locked)),
//   };
// }

export function getFreeCapital({
  orders,
  btc,
  fdusd,
}: Required<Pick<State, "orders" | "btc" | "fdusd">>) {
  const additionalLockedBtc = orders
    .filter((x) => x.side === "SELL" && x.customState === "CREATING")
    .reduce((sum, x) => sum.add(x.quantity), new Decimal(0));

  const additionalLockedfdusd = orders
    .filter((x) => x.side === "BUY" && x.customState === "CREATING")
    .reduce((sum, x) => sum.add(x.quantity.times(x.price)), new Decimal(0));

  return {
    btc: btc.free.minus(additionalLockedBtc),
    fdusd: fdusd.free.minus(additionalLockedfdusd),
  };
}

export function getTotalEquity({
  btc,
  fdusd,
  lastTrade,
}: Required<Pick<State, "btc" | "fdusd" | "lastTrade">>) {
  return fdusd.free
    .add(fdusd.locked)
    .add(btc.free.times(lastTrade.price))
    .add(btc.locked.times(lastTrade.price));
}

const safe_pct = 0.2;
const btc_min_unit = 0.0002;

export function createMissingOrders(
  state: State &
    Required<
      Pick<
        State,
        "levelSizeQuote" | "currentLevelPrice" | "lastTrade" | "btc" | "fdusd"
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

    const safeUsd = freeCapital.fdusd
      .minus(totalEquity.times(safe_pct))
      .clamp(0, totalEquity);

    if (safeUsd.gt(orderQuoteQuantity.times(0.95))) {
      const level = getNextAvailableLevel(state, "BUY");

      if (safeUsd.lte(orderQuoteQuantity.times(1 + 0.95))) {
        orderQuoteQuantity = safeUsd;
      }

      console.log(dheader(), "Creating BUY order", {
        safeUsd,
        freeCapital,
        price: level.price,
        level: level.level,
        orderQuoteQuantity,
        orderBaseQuantity,
        totalEquity,
      });

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

      if (
        freeCapital.btc.lte(orderBaseQuantity.times(1.05).add(btc_min_unit))
      ) {
        orderBaseQuantity = freeCapital.btc.sub(btc_min_unit);
      }

      console.log(dheader(), "Creating SELL order", {
        xx: state.btc,
        // yy: state.orders.filter((x) => x.side == "SELL"),
        freeCapital,
        price: level.price,
        level: level.level,
        orderQuoteQuantity,
        orderBaseQuantity,
        totalEquity,
      });

      state = {
        ...state,
        orders: state.orders.concat(
          createOrder("SELL", level.price, level.level, orderBaseQuantity)
        ),
      };
    }

    runawayCounter += 1;
    if (runawayCounter > 20) {
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
    console.log(
      dheader(),
      "Moving level up to",
      currentLevelIndex + 1,
      currentLevelPrice.add(levelSizeQuote),
      "because",
      lastTrade.price,
      ">",
      currentLevelPrice,
      "+",
      levelSizeQuote
    );

    currentLevelIndex += 1;
    currentLevelPrice = currentLevelPrice.add(levelSizeQuote);

    runawayCounter += 1;
    if (runawayCounter > 100) {
      throw new Error(
        "Runaway loop detected in updateCurrentIndex Moving level up"
      );
    }
  }

  runawayCounter = 0;
  while (lastTrade.price.lte(currentLevelPrice.sub(levelSizeQuote))) {
    console.log(
      dheader(),
      "Moving level down to",
      currentLevelIndex - 1,
      currentLevelPrice.sub(levelSizeQuote),
      "because",
      lastTrade.price,
      "<",
      currentLevelPrice,
      "-",
      levelSizeQuote
    );

    currentLevelIndex -= 1;
    currentLevelPrice = currentLevelPrice.sub(levelSizeQuote);

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
      fdusd: action.payload.fdusd,
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
