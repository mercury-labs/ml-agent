export type ColumnType =
  | "text"
  | "rich_text"
  | "number"
  | "rating"
  | "date"
  | "user"
  | "channel"
  | "select"
  | "checkbox"
  | "currency"
  | "url"
  | "emoji"
  | "attachment"
  | "link"
  | "message"
  | "reference"
  | "todo_assignee"
  | "todo_due_date"
  | "todo_completed"
  | "unknown";

export type SelectChoice = {
  value: string;
  label?: string;
  color?: string;
};

export type ColumnOptions = {
  choices?: SelectChoice[];
  default_value_typed?: Record<string, unknown>;
  notify_users?: boolean;
  show_member_name?: boolean;
  format?: string;
  precision?: number;
  emoji?: string;
  emoji_team_id?: string;
  date_format?: string;
  max?: number;
};

export type ListColumn = {
  id: string;
  key?: string;
  name: string;
  type: ColumnType;
  is_primary_column?: boolean;
  options?: ColumnOptions;
};

export type ListSchema = {
  list_id: string;
  columns: ListColumn[];
};
