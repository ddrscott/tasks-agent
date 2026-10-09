// What the worksheet grid (client) and the worksheet store (Worker, sheets.ts) both know:
// the column types and the shapes that cross the API. No Worker imports here, so the
// client bundle can pull it in.

export const COLUMN_TYPES = ["text", "number", "date", "checkbox", "link"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export type Column = { id: string; name: string; type: ColumnType; pos: number };
export type SheetInfo = { id: string; name: string; columns: Column[]; rows: number; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string };
export type Cell = string | number | null;
/** A row as read: the table's own three columns, then the sheet's by name. */
export type Row = { _id: number; _at: string; _by: string } & Record<string, Cell>;
export type QueryResult = { columns: string[]; rows: Cell[][]; truncated: boolean };
