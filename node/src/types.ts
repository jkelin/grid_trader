import { OrderSide, OrderStatus, WsFormattedMessage } from "binance";
import { Decimal } from "decimal.js";

export interface WsAction {
  readonly type: "ws";
  readonly payload: WsFormattedMessage;
}

export interface UpdateSettingsAction {
  readonly type: "updateSettings";
  readonly payload: {
    readonly levelSize: number;
  };
}

export interface UpdateBalance {
  readonly type: "updateBalance";
  readonly payload: {
    readonly fdusd: Balance;
    readonly btc: Balance;
  };
}

export type Action = WsAction | UpdateSettingsAction | UpdateBalance;

export interface Balance {
  readonly free: Decimal;
  readonly locked: Decimal;
}

export interface Order {
  readonly side: OrderSide;
  readonly status?: OrderStatus;
  readonly id?: number;
  readonly customId: string;
  readonly level: number;
  readonly price: Decimal;
  readonly quantity: Decimal;
  readonly customState: "CREATING" | "ACTIVE" | "CANCELLING";
}

export interface State {
  readonly levelSizeQuote?: Decimal;
  readonly currentLevelPrice?: Decimal;
  readonly currentLevelIndex: number;
  readonly targetTotalLevels: number;

  readonly fdusd?: Balance;
  readonly btc?: Balance;
  readonly orders: ReadonlyArray<Order>;
  readonly lastTrade?: {
    readonly id: number;
    readonly price: Decimal;
  };
}

export interface ReducerContext {
  promise<TParam extends readonly unknown[]>(
    name: string,
    generator: (...parameters: [...TParam]) => Promise<unknown>,
    ...parameters: TParam
  ): void;
  dispatch(action: Action): void;
}
