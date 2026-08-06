/** @profit/ui — PROFIT TOOL AI design system (P9). Tokens via ./tokens.css. */
export { cn } from "./cn";
export { ThemeProvider, useTheme, THEME_STORAGE_KEY } from "./hooks/theme";
export type { ThemeChoice, ResolvedTheme, ThemeContextValue, ThemeProviderProps } from "./hooks/theme";
export {
  Button,
  Badge,
  Card,
  CardHeader,
  CardBody,
  Input,
  Select,
  Textarea,
} from "./components/primitives";
export type {
  ButtonProps,
  ButtonVariant,
  ButtonSize,
  BadgeProps,
  BadgeTone,
  CardProps,
  CardHeaderProps,
  InputProps,
  SelectProps,
  TextareaProps,
} from "./components/primitives";
export {
  Spinner,
  Skeleton,
  SkeletonText,
  ProgressBar,
  AnimatedNumber,
  EmptyState,
  ErrorState,
} from "./components/feedback";
export {
  Modal,
  Drawer,
  ConfirmDialog,
  DropdownMenu,
  Tabs,
} from "./components/overlays";
export type { ModalProps, DrawerProps, MenuItem, TabItem } from "./components/overlays";
export { ToastProvider, useToast } from "./components/toast";
export type { Toast, ToastApi, ToastTone } from "./components/toast";
export { DataTable, StatCard } from "./components/table";
export type { ColumnDef, DataTableProps, SortDirection } from "./components/table";
export { AreaChart, Sparkline, Gauge, HealthBar } from "./charts/charts";
export type { AreaChartProps } from "./charts/charts";
export {
  compactNumber,
  formatMoney,
  formatDateLabel,
  niceTicks,
  seriesExtent,
  toPoints,
  smoothPath,
  areaPath,
} from "./charts/chart-utils";
export type { DataPoint, Series } from "./charts/chart-utils";
