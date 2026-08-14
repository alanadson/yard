/**
 * Visual identity of projects: icon + color chosen by the user.
 *
 * The database stores only the icon **name** (key of this registry), never
 * the component — so an unknown name (old version, migrated data)
 * falls back to the default folder instead of breaking the tree.
 */
import {
  Blocks,
  BookOpen,
  Bot,
  Briefcase,
  Bug,
  ChartColumn,
  Cloud,
  Cpu,
  Database,
  Eye,
  FlaskConical,
  Folder,
  Gamepad2,
  Gauge,
  GitBranch,
  Globe,
  GraduationCap,
  Heart,
  House,
  Keyboard,
  Laptop,
  Layers,
  Leaf,
  Lightbulb,
  Lock,
  MessageCircle,
  Monitor,
  Music,
  Package,
  Paintbrush,
  Rocket,
  Server,
  Settings,
  Shield,
  ShoppingCart,
  Smile,
  Sparkles,
  SquareTerminal,
  Wand,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** Registry order = order in the picker grid. */
export const PROJECT_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  terminal: SquareTerminal,
  rocket: Rocket,
  sparkles: Sparkles,
  globe: Globe,
  server: Server,
  database: Database,
  cloud: Cloud,
  cpu: Cpu,
  bot: Bot,
  zap: Zap,
  wrench: Wrench,
  settings: Settings,
  bug: Bug,
  shield: Shield,
  lock: Lock,
  "git-branch": GitBranch,
  blocks: Blocks,
  package: Package,
  layers: Layers,
  keyboard: Keyboard,
  laptop: Laptop,
  monitor: Monitor,
  gauge: Gauge,
  paintbrush: Paintbrush,
  wand: Wand,
  eye: Eye,
  chart: ChartColumn,
  briefcase: Briefcase,
  "shopping-cart": ShoppingCart,
  message: MessageCircle,
  book: BookOpen,
  "graduation-cap": GraduationCap,
  flask: FlaskConical,
  lightbulb: Lightbulb,
  leaf: Leaf,
  heart: Heart,
  house: House,
  music: Music,
  gamepad: Gamepad2,
  smile: Smile,
};

export const DEFAULT_PROJECT_ICON = "folder";

/** Icon by persisted name; an unknown name falls back to the default folder. */
export function projectIcon(name?: string | null): LucideIcon {
  return (name && PROJECT_ICONS[name]) || PROJECT_ICONS[DEFAULT_PROJECT_ICON];
}

/**
 * Project color palette. Same chroma family as the semantic tokens and the
 * canvas palette — the macOS system hues tuned for the dark ground: vivid
 * enough to distinguish, but without shouting over the chrome.
 * `null` = neutral (theme gray).
 */
export const PROJECT_COLORS: readonly (string | null)[] = [
  null,
  "#5fa8ff", // blue
  "#5fd2d2", // cyan
  "#40d16e", // green
  "#f0c33c", // yellow
  "#ffa35c", // orange
  "#ff6961", // red
  "#ff7fa6", // pink
  "#c98bf2", // purple
] as const;
