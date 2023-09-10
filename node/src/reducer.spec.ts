import { Decimal } from "decimal.js";
import { it, expect, describe, vi } from "vitest";
import { cancelOutdatedOrders, getNextAvailableLevel } from "./reducer.js";
import { State } from "./types.js";
import { cancelOrder } from "./client.js";

describe("getNextAvailableLevel", () => {
  it("buy empty", () => {
    expect(
      getNextAvailableLevel(
        {
          currentLevelPrice: new Decimal(100),
          currentLevelIndex: 0,
          levelSizeQuote: new Decimal(20),
          orders: [],
        },
        "BUY"
      )
    ).toEqual({
      level: -1,
      price: new Decimal(80),
    });
  });

  it("buy with orders", () => {
    expect(
      getNextAvailableLevel(
        {
          currentLevelPrice: new Decimal(100),
          currentLevelIndex: 0,
          levelSizeQuote: new Decimal(20),
          orders: [
            {
              side: "BUY",
              price: new Decimal(80),
              level: -1,
              quantity: new Decimal(1),
              customId: "1",
              customState: "ACTIVE",
            },
          ],
        },
        "BUY"
      )
    ).toEqual({
      level: -2,
      price: new Decimal(60),
    });
  });

  it("buy with skip orders", () => {
    expect(
      getNextAvailableLevel(
        {
          currentLevelPrice: new Decimal(100),
          currentLevelIndex: 0,
          levelSizeQuote: new Decimal(20),
          orders: [
            {
              side: "BUY",
              price: new Decimal(80),
              level: -1,
              quantity: new Decimal(1),
              customId: "1",
              customState: "ACTIVE",
            },
            {
              side: "BUY",
              price: new Decimal(40),
              level: -3,
              quantity: new Decimal(1),
              customId: "2",
              customState: "ACTIVE",
            },
          ],
        },
        "BUY"
      )
    ).toEqual({
      level: -2,
      price: new Decimal(60),
    });
  });

  it("sell with skip orders", () => {
    expect(
      getNextAvailableLevel(
        {
          currentLevelPrice: new Decimal(100),
          currentLevelIndex: 0,
          levelSizeQuote: new Decimal(20),
          orders: [
            {
              side: "SELL",
              price: new Decimal(80),
              level: -1,
              quantity: new Decimal(1),
              customId: "1",
              customState: "ACTIVE",
            },
            {
              side: "SELL",
              price: new Decimal(40),
              level: 3,
              quantity: new Decimal(1),
              customId: "2",
              customState: "ACTIVE",
            },
          ],
        },
        "SELL"
      )
    ).toEqual({
      level: 1,
      price: new Decimal(120),
    });
  });
});

describe("cancelOutdatedOrders", () => {
  const state = {
    levelSizeQuote: new Decimal(10),
    currentLevelPrice: new Decimal(100),
    currentLevelIndex: 8,
    targetTotalLevels: 10,
    lastTrade: {
      id: 1,
      price: new Decimal(100),
    },
    orders: [
      {
        side: "BUY",
        customState: "ACTIVE",
        level: 1,
        price: new Decimal(100),
        customId: "order1",
        quantity: new Decimal(1),
      },
      {
        side: "BUY",
        customState: "ACTIVE",
        level: 2,
        price: new Decimal(90),
        customId: "order2",
        quantity: new Decimal(1),
      },
      {
        side: "BUY",
        customState: "ACTIVE",
        level: 3,
        price: new Decimal(80),
        customId: "order3",
        quantity: new Decimal(1),
      },
      {
        side: "BUY",
        customState: "ACTIVE",
        level: 4,
        price: new Decimal(70),
        customId: "order4",
        quantity: new Decimal(1),
      },
      {
        side: "BUY",
        customState: "ACTIVE",
        level: 5,
        price: new Decimal(60),
        customId: "order5",
        quantity: new Decimal(1),
      },
      {
        side: "BUY",
        customState: "ACTIVE",
        level: 6,
        price: new Decimal(50),
        customId: "order6",
        quantity: new Decimal(1),
      },
    ],
  } satisfies State;

  it("should cancel first order to move up", () => {
    const ctx = {
      promise: vi.fn(),
      dispatch: vi.fn(),
    };

    const expectedState = {
      ...state,
      orders: [
        {
          ...state.orders[0],
          customState: "CANCELLING",
        },
        ...state.orders.slice(1),
      ],
    } satisfies State;

    const result = cancelOutdatedOrders(state, ctx, "BUY");

    expect(result).toEqual(expectedState);
    expect(ctx.promise).toHaveBeenCalledWith(
      "cancelOrder",
      cancelOrder,
      state.orders[0]
    );
  });

  it("should cancel the second order if first is already cancelled", () => {
    const ctx = {
      promise: vi.fn(),
      dispatch: vi.fn(),
    };

    const innerState = {
      ...state,
      currentLevelIndex: 9,
      orders: [
        {
          ...state.orders[0],
          customState: "CANCELLING",
        },
        ...state.orders.slice(1),
      ],
    } satisfies State;

    const expectedState = {
      ...innerState,
      orders: [
        innerState.orders[0],
        {
          ...innerState.orders[1],
          customState: "CANCELLING",
        },
        ...innerState.orders.slice(2),
      ],
    } satisfies State;

    const result = cancelOutdatedOrders(innerState, ctx, "BUY");

    expect(result).toEqual(expectedState);
    expect(ctx.promise).toHaveBeenCalledWith(
      "cancelOrder",
      cancelOrder,
      innerState.orders[1]
    );
  });

  it("should cancel second order to move up if first is creating", () => {
    const ctx = {
      promise: vi.fn(),
      dispatch: vi.fn(),
    };

    const innerState = {
      ...state,
      currentLevelIndex: 8,
      orders: [
        {
          ...state.orders[0],
          customState: "CREATING",
        },
        ...state.orders.slice(1),
      ],
    } satisfies State;

    const expectedState = {
      ...innerState,
      orders: [
        innerState.orders[0],
        {
          ...innerState.orders[1],
          customState: "CANCELLING",
        },
        ...innerState.orders.slice(2),
      ],
    } satisfies State;

    const result = cancelOutdatedOrders(innerState, ctx, "BUY");

    expect(result).toEqual(expectedState);
    expect(ctx.promise).toHaveBeenCalledWith(
      "cancelOrder",
      cancelOrder,
      innerState.orders[1]
    );
  });

  it("orders should stay in place", () => {
    const ctx = {
      promise: vi.fn(),
      dispatch: vi.fn(),
    };

    const innerState = {
      ...state,
      currentLevelIndex: 7,
    } satisfies State;

    const result = cancelOutdatedOrders(innerState, ctx, "BUY");

    expect(result).toEqual(innerState);
    expect(ctx.promise).not.toHaveBeenCalled();
  });

  it("should not cancel anything when order is creating in correct place", () => {
    const ctx = {
      promise: vi.fn(),
      dispatch: vi.fn(),
    };

    const innerState = {
      ...state,
      currentLevelIndex: 7,
      orders: [
        ...state.orders.slice(0, 5),
        {
          ...state.orders[5],
          customState: "CREATING",
        },
      ],
    } satisfies State;

    const result = cancelOutdatedOrders(innerState, ctx, "BUY");

    expect(result).toEqual(innerState);
    expect(ctx.promise).not.toHaveBeenCalled();
  });
});
