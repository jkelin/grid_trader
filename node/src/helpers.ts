import { MeasureUnit, globalStats } from "@opencensus/core";
import { format } from "date-fns";

export const measurementExecutionReport = globalStats.createMeasureDouble(
  "latency/executionReport",
  MeasureUnit.MS,
  "Latency in MS for receiving executionReport over websocket"
);

export const measurementOutboundAccountPosition =
  globalStats.createMeasureDouble(
    "latency/outboundAccountPosition",
    MeasureUnit.MS,
    "Latency in MS for receiving outboundAccountPosition over websocket"
  );

// Memory leak here, hope it wont be that bad
export const customIdToLevel = new Map<string, number>();

export function parseCustomId(...ids: string[]) {
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

export function dheader() {
  return `[${format(new Date(), "HH:mm:ss.SSS")}]`;
}
