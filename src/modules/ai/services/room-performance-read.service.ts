import type { Database } from "../../../plugins/database.js";
import {
  getRoomPerformanceReport,
  type RoomPerformanceMode,
  type RoomPerformanceSource,
} from "../../reports/services/room-performance-report.service.js";

type AiRoomPerformanceArgs = {
  weekStart: string;
  roomType?: string;
  source?: RoomPerformanceSource;
  mode: RoomPerformanceMode;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAiRoomPerformanceArgs(value: unknown): AiRoomPerformanceArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid room performance arguments");
  }
  const input = value as Record<string, unknown>;
  const weekStart = input.weekStart;
  const date = typeof weekStart === "string" ? new Date(`${weekStart}T00:00:00.000Z`) : null;
  if (
    Object.keys(input).some((key) => !["weekStart", "roomType", "source", "mode"].includes(key)) ||
    typeof weekStart !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) ||
    !date ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== weekStart ||
    (input.roomType !== undefined &&
      (typeof input.roomType !== "string" || !uuidPattern.test(input.roomType))) ||
    (input.source !== undefined &&
      !["website", "phone", "walk_in", "ota"].includes(input.source as string)) ||
    (input.mode !== undefined && !["actual", "projected"].includes(input.mode as string))
  ) {
    throw new Error("Invalid room performance arguments");
  }
  return {
    weekStart,
    roomType: input.roomType as string | undefined,
    source: input.source as RoomPerformanceSource | undefined,
    mode: (input.mode as RoomPerformanceMode | undefined) ?? "actual",
  };
}

export function getAiRoomPerformance(db: Database, args: AiRoomPerformanceArgs) {
  return getRoomPerformanceReport(db, args);
}
