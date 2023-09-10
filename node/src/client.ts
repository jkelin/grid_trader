import { Decimal } from "decimal.js";
import { Action, Order } from "./types.js";
import {
  MainClient,
  OrderSide,
  WebsocketClient,
  generateNewOrderId,
} from "binance";
import { customIdToLevel } from "./helpers.js";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import got from "got";

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

export const binanceClient = new MainClient({
  api_key: process.env.BINANCE_KEY,
  api_secret: process.env.BINANCE_SECRET,
});

export const binanceSocketClient = new WebsocketClient(
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

export async function createOrderAtLevel({
  price,
  side,
  quantity,
  level,
  customId,
}: {
  price: Decimal;
  side: OrderSide;
  quantity: Decimal;
  level: number;
  customId?: string;
}) {
  let runawayCounter = 0;
  while (true) {
    const buyQuantity = quantity.toDecimalPlaces(5, Decimal.ROUND_DOWN);
    customId = customId ?? generateNewOrderId("spot");
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

export async function cancelOrder(order: Order) {
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

export async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchBalance() {
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

export async function closeAll() {
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
        quantity: balances.btc.free
          .toDecimalPlaces(5, Decimal.ROUND_DOWN)
          .toNumber(),
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

export async function keepUpdatingSettingsFromAPI(
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
