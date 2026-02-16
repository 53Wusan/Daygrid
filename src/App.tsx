import React, { useEffect, useMemo, useRef, useState } from "react";
import localforage from "localforage";
import { Haptics, ImpactStyle } from "@capacitor/haptics";

/**
 * DayGrid (mobile-first)
 * - 96 slots/day (15m each), displayed as 12 rows x 8 cols (2 hours per row)
 * - Events rendered as segments overlay
 * - Interaction:
 *   - Tap selects SINGLE slot (always replaces previous selection, closes modal)
 *   - Horizontal drag selects range (no long-press required)
 *   - Vertical move becomes scroll (doesn't trigger selection)
 * - Local persistence + recent + fixed copy + stats day/week/month + overview + import/export
 * - Calendarist-style color family:
 *   - Category has stable hue
 *   - Events under same category vary by lightness/saturation
 */

type Tab = "record" | "stats" | "more";
type ThemeMode = "system" | "light" | "dark";
type StatsMode = "overview" | "day" | "week" | "month";

type Category = { id: string; name: string };
type EventTag = { id: string; categoryId: string; name?: string; fixed?: boolean };
type DayLog = { dateKey: string; slots: (string | null)[] };

type Settings = {
  nightStart: string;
  nightEnd: string;
  nightDisplay30: boolean; // compatibility (UI always 15m)
  themeMode: ThemeMode;
};

const SLOT_MINUTES = 15;
const TOTAL_SLOTS = 96;
const START_HOUR = 8; // timeline starts at 08:00
const RECENT_LIMIT = 8;

// gesture tuning
const DRAG_START_PX = 6;
const AXIS_LOCK_RATIO = 1.2;
const SCROLL_CANCEL_PX = 8;

const store = localforage.createInstance({ name: "daygrid" });

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
function toDateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(dateKey: string, delta: number) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return toDateKey(dt);
}
function slotToTime(slotIndex: number) {
  const totalMinutes = slotIndex * SLOT_MINUTES;
  const h = Math.floor(totalMinutes / 60);
  const min = totalMinutes % 60;
  const displayHour = (START_HOUR + h) % 24;
  return `${pad2(displayHour)}:${pad2(min)}`;
}
function hmToMinutes(hm: string) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function getWeekStartKey(dateKey: string) {
  // Week starts Monday
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const day = dt.getDay(); // 0 Sun .. 6 Sat
  const deltaToMon = (day + 6) % 7;
  dt.setDate(dt.getDate() - deltaToMon);
  return toDateKey(dt);
}

function getMonthStartKey(dateKey: string) {
  const [y, m] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, 1);
  return toDateKey(dt);
}
function getDaysInMonth(dateKey: string) {
  const [y, m] = dateKey.split("-").map(Number);
  return new Date(y, m, 0).getDate(); // last day of month
}
function getMonthKeys(dateKey: string) {
  const start = getMonthStartKey(dateKey);
  const n = getDaysInMonth(dateKey);
  return Array.from({ length: n }, (_, i) => addDays(start, i));
}

function dayKeyToDate(dateKey: string) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** ===== Calendarist-like color family ===== */
function hash01(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619;
  return ((h >>> 0) % 10000) / 10000; // 0~1
}
function categoryHue(categoryId: string) {
  return Math.floor(hash01(categoryId) * 360);
}
function categoryAccent(categoryId: string, isDark: boolean) {
  const hue = categoryHue(categoryId);
  const s = isDark ? 70 : 72;
  const l = isDark ? 62 : 45;
  return `hsl(${hue} ${s}% ${l}%)`;
}
function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function hashTo01(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function hsl(h: number, s: number, l: number, a = 1) {
  return `hsla(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%, ${a})`;
}

/* ✅ 方案 A：一级同色系，二级明显阶梯区分 */
function eventColorFamily(categoryId: string, eventId: string, isDark: boolean) {
  // 一级决定主色相（同色系）
  const baseHue = Math.floor(hashTo01(categoryId) * 360);

  // 二级：在同色系里做“轻微色相偏移”，确保肉眼可见
  const hueOffset = Math.round((hashTo01(eventId) - 0.5) * 36); // -18 ~ +18
  const hue = (baseHue + hueOffset + 360) % 360;

  // 二级：再加亮度阶梯，让差异更稳定
  const tier = Math.floor(hashTo01("tier:" + eventId) * 6); // 0~5

  // Accent（小圆点/强调色）更明显
  const sAccent = isDark ? 78 : 86;
  const lAccentBase = isDark ? 56 : 40;
  const lAccent = lAccentBase + tier * (isDark ? 4 : 5);
  const accent = hsl(hue, sAccent, clamp01(lAccent / 100) * 100, 0.95);

  // Fill（块背景）更淡，但也跟随 tier 变化
  const sFill = isDark ? 55 : 62;
  const lFillBase = isDark ? 22 : 92;
  const lFill = lFillBase - tier * (isDark ? 1.3 : 1.7);
  const fill = hsl(hue, sFill, clamp01(lFill / 100) * 100, isDark ? 0.55 : 0.88);

  return { fill, accent };
}

function formatEventLabel(ev: EventTag | undefined, catName: string | undefined) {
  if (!ev) return "";
  const c = catName ?? "未分类";
  if (!ev.name || ev.name.trim() === "") return c;
  return `${c}/${ev.name}`;
}

async function loadSettings(): Promise<Settings> {
  const s = await store.getItem<Settings>("settings");
  if (s) return s;
  const init: Settings = {
    nightStart: "23:00",
    nightEnd: "08:00",
    nightDisplay30: false,
    themeMode: "system",
  };
  await store.setItem("settings", init);
  return init;
}
async function saveSettings(s: Settings) {
  await store.setItem("settings", s);
}

async function loadMeta() {
  const defaultCategories: Category[] = [
    { id: "cat_life", name: "生活" },
    { id: "cat_study", name: "学习" },
    { id: "cat_work", name: "工作" },
  ];

  const defaultEvents: EventTag[] = [
    { id: "evt_life_sleep", categoryId: "cat_life", name: "睡觉", fixed: true },
    { id: "evt_life_commute", categoryId: "cat_life", name: "通勤", fixed: true },
    { id: "evt_life_eat", categoryId: "cat_life", name: "吃饭", fixed: true },
    { id: "evt_study_english", categoryId: "cat_study", name: "英语课", fixed: true },
    { id: "evt_work_only", categoryId: "cat_work", name: "未命名", fixed: false },
  ];

  const categories = (await store.getItem<Category[]>("categories")) ?? defaultCategories;
  const events = (await store.getItem<EventTag[]>("events")) ?? defaultEvents;

  const recent =
    (await store.getItem<string[]>("recentEvents")) ??
    ["evt_life_sleep", "evt_life_eat", "evt_life_commute", "evt_study_english", "evt_work_only"];

  await store.setItem("categories", categories);
  await store.setItem("events", events);
  await store.setItem("recentEvents", recent);

  return { categories, events, recent };
}
async function saveMeta(categories: Category[], events: EventTag[], recent: string[]) {
  await store.setItem("categories", categories);
  await store.setItem("events", events);
  await store.setItem("recentEvents", recent);
}

async function loadOrInitDay(dateKey: string): Promise<DayLog> {
  const key = `day:${dateKey}`;
  const d = await store.getItem<DayLog>(key);
  if (d?.slots?.length === TOTAL_SLOTS) return d;
  const fresh: DayLog = { dateKey, slots: Array.from({ length: TOTAL_SLOTS }, () => null) };
  await store.setItem(key, fresh);
  return fresh;
}
async function saveDay(day: DayLog) {
  await store.setItem(`day:${day.dateKey}`, day);
}

/** ===== Small SVG charts ===== */
function DonutChart(props: { items: { label: string; value: number; color: string }[]; size?: number; isDark: boolean }) {
  const size = props.size ?? 220;
  const stroke = 18;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  const total = props.items.reduce((s, x) => s + x.value, 0);
  if (total <= 0) {
    return (
      <div style={{ width: size, height: size, display: "grid", placeItems: "center", opacity: 0.7 }}>
        无数据
      </div>
    );
  }

  let offset = 0;
  const track = props.isDark ? "#1f2937" : "#eef2f7";
  const text = props.isDark ? "#f9fafb" : "#111827";
  const sub = props.isDark ? "#9ca3af" : "#6b7280";

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: "block" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      {props.items.map((it, idx) => {
        const frac = it.value / total;
        const len = c * frac;
        const dash = `${len} ${c - len}`;
        const dashOffset = -offset;
        offset += len;
        return (
          <circle
            key={idx}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={it.color}
            strokeWidth={stroke}
            strokeDasharray={dash}
            strokeDashoffset={dashOffset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        );
      })}
      <text x="50%" y="48%" textAnchor="middle" fontSize="18" fontWeight="900" fill={text}>
        {Math.round((total / 60) * 10) / 10}h
      </text>
      <text x="50%" y="60%" textAnchor="middle" fontSize="12" fill={sub}>
        本日总计
      </text>
    </svg>
  );
}

// 加载loading界面
function BootScreen(props: { isDark: boolean; title?: string; subtitle?: string }) {
  const { isDark } = props;
  const bg = isDark ? "#000000" : "#f5f5f7";
  const panel = isDark ? "rgba(255,255,255,0.06)" : "rgba(17,24,39,0.05)";
  const text = isDark ? "#f9fafb" : "#111827";
  const sub = isDark ? "#9ca3af" : "#6b7280";
  const border = isDark ? "rgba(255,255,255,0.12)" : "rgba(17,24,39,0.10)";

  return (
    <div
      style={{
        minHeight: "100dvh",
        height: "100dvh",
        display: "grid",
        placeItems: "center",
        background: bg,
        color: text,
        padding: 18,
        fontFamily: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial`,
      }}
    >
      <div
        style={{
          width: "min(520px, 94vw)",
          borderRadius: 26,
          padding: 18,
          border: `1px solid ${border}`,
          background: panel,
          boxShadow: isDark ? "0 20px 80px rgba(0,0,0,0.65)" : "0 20px 80px rgba(0,0,0,0.12)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 16,
              border: `1px solid ${border}`,
              background: isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.92)",
              display: "grid",
              placeItems: "center",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                background: isDark ? "rgba(255,255,255,0.08)" : "rgba(17,24,39,0.06)",
                position: "relative",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  backgroundImage:
                    "linear-gradient(to right, rgba(127,127,127,0.25) 1px, transparent 1px), linear-gradient(to bottom, rgba(127,127,127,0.25) 1px, transparent 1px)",
                  backgroundSize: "6px 6px",
                }}
              />
            </div>
          </div>

          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontSize: 18, fontWeight: 1000, letterSpacing: -0.2 }}>{props.title ?? "日格 DayGrid"}</div>
            <div style={{ fontSize: 13, color: sub, fontWeight: 900 }}>{props.subtitle ?? "让每 15 分钟更清晰"}</div>
          </div>
        </div>

        <div style={{ height: 14 }} />

        <div
          style={{
            height: 10,
            borderRadius: 999,
            background: isDark ? "rgba(255,255,255,0.08)" : "rgba(17,24,39,0.06)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "45%",
              background: isDark
                ? "linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)"
                : "linear-gradient(90deg, transparent, rgba(17,24,39,0.10), transparent)",
              animation: "dg_shimmer 1.1s ease-in-out infinite",
            }}
          />
        </div>

        <style>{`
          @keyframes dg_shimmer {
            0% { transform: translateX(-60%); }
            100% { transform: translateX(240%); }
          }
        `}</style>
      </div>
    </div>
  );
}

/** ===== Week visualization ===== */
function WeekStackBar(props: {
  days: { dateKey: string; total: number; parts: { label: string; minutes: number; color: string }[] }[];
  isDark: boolean;
}) {
  const track = props.isDark ? "rgba(255,255,255,0.10)" : "rgba(17,24,39,0.08)";
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {props.days.map((d) => (
        <div
          key={d.dateKey}
          style={{ display: "grid", gridTemplateColumns: "86px 1fr 54px", gap: 10, alignItems: "center" }}
        >
          <div style={{ fontWeight: 950, opacity: 0.75 }}>{d.dateKey.slice(5)}</div>

          <div
            style={{
              height: 12,
              borderRadius: 999,
              overflow: "hidden",
              background: track,
              display: "flex",
            }}
          >
            {d.parts.map((p, idx) => {
              const w = d.total > 0 ? (p.minutes / d.total) * 100 : 0;
              if (w <= 0.6) return null;
              return <div key={idx} style={{ width: `${w}%`, background: p.color }} />;
            })}
          </div>

          <div style={{ textAlign: "right", fontWeight: 950, opacity: 0.75 }}>{Math.round((d.total / 60) * 10) / 10}h</div>
        </div>
      ))}
    </div>
  );
}

/** ===== Modal ===== */
function EventPickerModal(props: {
  categories: Category[];
  events: EventTag[];
  recentEvents: string[];
  eventById: Map<string, EventTag>;
  catById: Map<string, Category>;
  onClose: () => void;
  onPick: (eventId: string) => void;
  isDark: boolean;
}) {
  const { categories, events, recentEvents, eventById, catById, onClose, onPick, isDark } = props;

  const bg = isDark ? "rgba(0,0,0,0.62)" : "rgba(0,0,0,0.35)";
  const panel = isDark ? "#0b0f17" : "#ffffff";
  const border = isDark ? "rgba(255,255,255,0.12)" : "rgba(17,24,39,0.10)";
  const text = isDark ? "#f9fafb" : "#111827";
  const sub = isDark ? "#9ca3af" : "#6b7280";
  const chipBg = isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.92)";

  return (
    <div style={{ ...modalStyles.backdrop, background: bg }} data-noclear="true" onPointerDown={onClose}>
      <div style={{ ...modalStyles.modal, background: panel, border: `1px solid ${border}` }} onPointerDown={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <div style={{ fontWeight: 950, color: text, fontSize: 16 }}>选择事件</div>
          <button style={{ ...modalStyles.closeBtn, border: `1px solid ${border}`, color: text, background: chipBg }} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: sub, marginBottom: 6 }}>最近</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {recentEvents.map((id) => {
              const ev = eventById.get(id);
              if (!ev) return null;
              const cat = catById.get(ev.categoryId);
              const label = ev.name ? `${cat?.name ?? "未分类"}/${ev.name}` : cat?.name ?? "未分类";
              return (
                <button
                  key={id}
                  style={{ ...modalStyles.chip, border: `1px solid ${border}`, background: chipBg, color: text }}
                  onClick={() => onPick(id)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ marginTop: 14, maxHeight: "58vh", overflow: "auto" }}>
          {categories.map((c) => {
            const evs = events.filter((e) => e.categoryId === c.id);
            return (
              <div
                key={c.id}
                style={{
                  ...modalStyles.group,
                  border: `1px solid ${border}`,
                  background: isDark ? "rgba(255,255,255,0.03)" : "rgba(17,24,39,0.03)",
                }}
              >
                <div style={{ fontWeight: 950, color: text }}>{c.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  {evs
                    .filter((e) => e.name && e.name.trim() !== "")
                    .map((ev) => (
                      <button
                        key={ev.id}
                        style={{ ...modalStyles.chip, border: `1px solid ${border}`, background: chipBg, color: text }}
                        onClick={() => onPick(ev.id)}
                      >
                        {ev.name}
                      </button>
                    ))}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button style={{ ...modalStyles.smallBtn, border: `1px solid ${border}`, background: chipBg, color: text }} onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

const modalStyles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
    zIndex: 9999,
  },
  modal: {
    width: "min(720px, 96vw)",
    borderRadius: 20,
    padding: 12,
    boxShadow: "0 18px 60px rgba(0,0,0,0.35)",
  },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  closeBtn: { borderRadius: 14, cursor: "pointer", width: 36, height: 36, display: "grid", placeItems: "center" },
  chip: { borderRadius: 999, padding: "9px 11px", cursor: "pointer", fontWeight: 900 },
  group: { borderRadius: 18, padding: 10, marginTop: 10 },
  smallBtn: { borderRadius: 14, padding: "10px 12px", cursor: "pointer", fontWeight: 900 },
};

/** ===== Theme ===== */
function makeThemeTokens(isDark: boolean) {
  const light = {
    bg: "#f5f5f7",
    panel: "#ffffff",
    text: "#0b0f17",
    sub: "#6b7280",
    hairline: "rgba(17,24,39,0.06)",
    shadow: "0 10px 22px rgba(0,0,0,0.08)",
    headerBg: "rgba(245,245,247,0.82)",
    chipBg: "rgba(255,255,255,0.90)",
    chipBorder: "rgba(17,24,39,0.10)",
    blue: "rgba(0,122,255,0.16)",
    blueLine: "rgba(0,122,255,0.45)",
  };
  const dark = {
    bg: "#000000",
    panel: "#0b0f17",
    text: "#f9fafb",
    sub: "#9ca3af",
    hairline: "rgba(255,255,255,0.08)",
    shadow: "0 10px 30px rgba(0,0,0,0.55)",
    headerBg: "rgba(0,0,0,0.62)",
    chipBg: "rgba(255,255,255,0.06)",
    chipBorder: "rgba(255,255,255,0.14)",
    blue: "rgba(10,132,255,0.22)",
    blueLine: "rgba(10,132,255,0.60)",
  };
  return isDark ? dark : light;
}

/** ===== Aggregation helpers (Day/Week/Month/Overview) ===== */
type Agg = {
  totalMinutes: number;
  byCat: Map<string, number>;
  byEvent: Map<string, number>;
};

function aggregateDays(
  days: Array<DayLog | null | undefined>,
  eventById: Map<string, EventTag>
) {
  // ✅ 任何 null/undefined 都跳过，避免读取 slots 报错
  const byEventSlots = new Map<string, number>(); // eventId -> slots
  const byCatSlots = new Map<string, number>(); // categoryId -> slots
  let totalSlots = 0;

  for (const d of days) {
    if (!d || !Array.isArray(d.slots)) continue;

    for (const eid of d.slots) {
      if (!eid) continue;

      totalSlots += 1;
      byEventSlots.set(eid, (byEventSlots.get(eid) ?? 0) + 1);

      const ev = eventById.get(eid);
      const catId = ev?.categoryId ?? "cat_deleted";
      byCatSlots.set(catId, (byCatSlots.get(catId) ?? 0) + 1);
    }
  }

  // ✅ 把 slots -> minutes
  const byEvent = new Map<string, number>();
  for (const [id, slots] of byEventSlots.entries()) byEvent.set(id, slots * SLOT_MINUTES);

  const byCat = new Map<string, number>();
  for (const [id, slots] of byCatSlots.entries()) byCat.set(id, slots * SLOT_MINUTES);

  return {
    totalMinutes: totalSlots * SLOT_MINUTES,
    byEvent,
    byCat,
  };
}



function topNFromMap(map: Map<string, number>, n: number) {
  return Array.from(map.entries())
    .map(([id, minutes]) => ({ id, minutes }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, n);
}

/** ===== App ===== */
export default function App() {
  const [tab, setTab] = useState<Tab>("record");
  const [statsMode, setStatsMode] = useState<StatsMode>("overview");

  const [dateKey, setDateKey] = useState<string>(toDateKey());
  const [day, setDay] = useState<DayLog | null>(null);

  const [statsCatFilter, setStatsCatFilter] = useState<string | null>(null);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [events, setEvents] = useState<EventTag[]>([]);
  const [recentEvents, setRecentEvents] = useState<string[]>([]);

  // selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchorRef = useRef<number | null>(null);

  const gestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    startSlot: number;
    mode: "pending" | "hdrag" | "scroll";
    pressEl: HTMLElement | null;
  } | null>(null);

  const [showPicker, setShowPicker] = useState(false);
  const [booting, setBooting] = useState(true);

  // system dark detection
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const update = () => setSystemDark(!!mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  const themeMode = settings?.themeMode ?? "system";
  const isDark = themeMode === "dark" ? true : themeMode === "light" ? false : systemDark;
  const theme = useMemo(() => makeThemeTokens(isDark), [isDark]);
  const styles = useMemo(() => makeStyles(theme, isDark), [theme, isDark]);

  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  // grid: 12 rows x 8 columns
  const gridRows = useMemo(() => Array.from({ length: 12 }, (_, r) => Array.from({ length: 8 }, (_, c) => r * 8 + c)), []);

  // now indicator
  const [nowSlot, setNowSlot] = useState<number | null>(null);
  useEffect(() => {
    const calcNowSlot = () => {
      const now = new Date();
      const minutesNow = now.getHours() * 60 + now.getMinutes();
      const startMinutes = START_HOUR * 60;
      let delta = minutesNow - startMinutes;
      if (delta < 0) delta += 24 * 60;
      const idx = Math.floor(delta / SLOT_MINUTES);
      if (idx < 0 || idx >= TOTAL_SLOTS) return null;
      return idx;
    };
    const tick = () => setNowSlot(calcNowSlot());
    tick();
    const t = window.setInterval(tick, 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  // init
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      setSettings(s);
      const meta = await loadMeta();
      setCategories(meta.categories);
      setEvents(meta.events);
      setRecentEvents(meta.recent);
    })();
  }, []);

  // load day
  useEffect(() => {
    (async () => {
      const d = await loadOrInitDay(dateKey);
      setDay(d);
      setSelected(new Set());
      anchorRef.current = null;
      setShowPicker(false);
      setStatsCatFilter(null);
      gestureRef.current = null;
    })();
  }, [dateKey]);

  // loading（只要 settings + day 准备好，就自动退出）
useEffect(() => {
  if (!settings || !day) return;

  // 如果已经退出过 loading，就不再进入
  setBooting((prev) => {
    if (!prev) return prev;
    return true;
  });

  const t = window.setTimeout(() => {
    setBooting(false);
  }, 120);

  return () => window.clearTimeout(t);
}, [settings, day]);


  // persist meta
  useEffect(() => {
    if (categories.length === 0 && events.length === 0) return;
    saveMeta(categories, events, recentEvents).catch(() => {});
  }, [categories, events, recentEvents]);

  // persist settings
  useEffect(() => {
    if (!settings) return;
    saveSettings(settings).catch(() => {});
  }, [settings]);

  async function hapticLight() {
    try {
      await Haptics.impact({ style: ImpactStyle.Light });
    } catch {
      navigator.vibrate?.(12);
    }
  }

  // ===== selection helpers =====
  function clearSelection() {
    setSelected(new Set());
    setShowPicker(false);
  }

  function selectRange(a: number, b: number) {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    const next = new Set<number>();
    for (let i = min; i <= max; i++) next.add(i);
    setSelected(next);
  }

  function isClickInsideNoClear(target: HTMLElement | null) {
    if (!target) return false;
    return !!target.closest("[data-noclear='true']");
  }

  function onCellPointerDown(e: React.PointerEvent, startSlot: number) {
    setShowPicker(false);
    anchorRef.current = startSlot;
    setSelected(new Set([startSlot]));

    gestureRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startSlot,
      mode: "pending",
      pressEl: e.currentTarget as HTMLElement,
    };
  }

  function onGridPointerMove(e: React.PointerEvent) {
    const g = gestureRef.current;
    if (!g || !g.active) return;
    if (e.pointerId !== g.pointerId) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (g.mode === "pending") {
      if (ady > SCROLL_CANCEL_PX && ady > adx * AXIS_LOCK_RATIO) {
        g.mode = "scroll";
        return;
      }
      if (adx > DRAG_START_PX && adx > ady * AXIS_LOCK_RATIO) {
        g.mode = "hdrag";
        try {
          g.pressEl?.setPointerCapture?.(g.pointerId);
        } catch {}
      } else {
        return;
      }
    }

    if (g.mode !== "hdrag") return;

    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const cellEl = el?.closest?.("[data-slot]") as HTMLElement | null;
    if (!cellEl) return;

    const slot = Number(cellEl.dataset.slot);
    if (Number.isNaN(slot)) return;

    selectRange(g.startSlot, slot);
  }

  function onPointerUp() {
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
  }

  async function applyEvent(eventId: string | null) {
    if (!day) return;
    if (selected.size === 0) return;

    const next: DayLog = { ...day, slots: [...day.slots] };
    selected.forEach((idx) => {
      if (idx >= 0 && idx < TOTAL_SLOTS) next.slots[idx] = eventId;
    });

    setDay(next);
    await saveDay(next);

    if (eventId) {
      setRecentEvents((prev) => {
        const filtered = prev.filter((x) => x !== eventId);
        return [eventId, ...filtered].slice(0, RECENT_LIMIT);
      });
    }

    clearSelection();
  }

  async function copyFixedFromPrevDay() {
    if (!day) return;
    const prevKey = addDays(day.dateKey, -1);
    const prev = await loadOrInitDay(prevKey);

    const fixedSet = new Set(events.filter((e) => e.fixed).map((e) => e.id));
    const next: DayLog = { ...day, slots: [...day.slots] };

    for (let i = 0; i < TOTAL_SLOTS; i++) {
      if (next.slots[i]) continue;
      const prevEid = prev.slots[i];
      if (prevEid && fixedSet.has(prevEid)) next.slots[i] = prevEid;
    }

    setDay(next);
    await saveDay(next);
  }

  function deleteCategory(catId: string) {
    const ok = confirm("确定删除这个一级标签吗？（不会自动删除其二级事件）");
    if (!ok) return;
    setCategories((prev) => prev.filter((c) => c.id !== catId));
  }

  function deleteEvent(evtId: string) {
    const ok = confirm("确定删除这个事件吗？（会清理当前日期中使用它的格子）");
    if (!ok) return;

    setEvents((prev) => prev.filter((e) => e.id !== evtId));
    setRecentEvents((prev) => prev.filter((x) => x !== evtId));

    if (day) {
      const next: DayLog = { ...day, slots: [...day.slots] };
      let changed = false;
      for (let i = 0; i < next.slots.length; i++) {
        if (next.slots[i] === evtId) {
          next.slots[i] = null;
          changed = true;
        }
      }
      if (changed) {
        setDay(next);
        saveDay(next);
      }
    }
  }

  async function exportJSON() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      dateKey,
      settings,
      categories,
      events,
      recentEvents,
      day,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `daygrid_${dateKey}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJSON(file: File) {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data?.day?.slots || data.day.slots.length !== TOTAL_SLOTS) {
      alert("导入失败：文件格式不正确");
      return;
    }

    if (data.settings) await store.setItem("settings", data.settings);
    if (data.categories) await store.setItem("categories", data.categories);
    if (data.events) await store.setItem("events", data.events);
    if (data.recentEvents) await store.setItem("recentEvents", data.recentEvents);
    await store.setItem(`day:${data.day.dateKey}`, data.day);

    const s = await loadSettings();
    setSettings(s);
    const meta = await loadMeta();
    setCategories(meta.categories);
    setEvents(meta.events);
    setRecentEvents(meta.recent);
    setDateKey(data.day.dateKey);
  }

  function addCategory(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCategories((prev) => [...prev, { id: uid("cat"), name: trimmed }]);
  }
  function addEvent(categoryId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    setEvents((prev) => [...prev, { id: uid("evt"), categoryId, name: trimmed, fixed: false }]);
  }

  function findSleepEventId() {
    const sleepEvt = events.find((e) => e.name?.trim() === "睡觉");
    return sleepEvt?.id ?? null;
  }

  async function fillSleep(overrideExisting: boolean) {
    if (!day || !settings) return;
    const sleepEventId = findSleepEventId();
    if (!sleepEventId) {
      alert("还没有“睡觉”事件，请先在“更多 → 事件管理”里创建。");
      return;
    }

    const next: DayLog = { ...day, slots: [...day.slots] };
    const ns = settings.nightStart;
    const ne = settings.nightEnd;

    const isInNightRange = (timeHHMM: string) => {
      const t = hmToMinutes(timeHHMM);
      const start = hmToMinutes(ns);
      const end = hmToMinutes(ne);
      if (start === end) return false;
      if (start < end) return t >= start && t < end;
      return t >= start || t < end;
    };

    for (let i = 0; i < TOTAL_SLOTS; i++) {
      const t = slotToTime(i);
      if (!isInNightRange(t)) continue;
      if (!overrideExisting && next.slots[i]) continue;
      next.slots[i] = sleepEventId;
    }

    setDay(next);
    await saveDay(next);

    setRecentEvents((prev) => {
      const filtered = prev.filter((x) => x !== sleepEventId);
      return [sleepEventId, ...filtered].slice(0, RECENT_LIMIT);
    });
  }

  // ===== selection info =====
  const selectionInfo = useMemo(() => {
    if (selected.size === 0) return null;
    const arr = Array.from(selected).sort((a, b) => a - b);
    const start = arr[0];
    const end = arr[arr.length - 1] + 1;
    const minutes = arr.length * SLOT_MINUTES;
    return { start, end, minutes, startTime: slotToTime(start), endTime: slotToTime(end) };
  }, [selected]);

  // ===== global segments =====
  const globalSegments = useMemo(() => {
    if (!day) return [];
    const segs: { start: number; end: number; len: number; eventId: string }[] = [];
    let i = 0;
    while (i < TOTAL_SLOTS) {
      const eid = day.slots[i];
      if (!eid) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < TOTAL_SLOTS && day.slots[j] === eid) j++;
      segs.push({ start: i, end: j, len: j - i, eventId: eid });
      i = j;
    }
    return segs;
  }, [day]);

  // ===== label + color helpers =====
  function getEventLabelAndColor(eventId: string) {
    const ev = eventById.get(eventId);
    if (!ev) return { label: "（已删除）", fill: isDark ? "rgba(255,255,255,0.10)" : "rgba(17,24,39,0.08)", accent: isDark ? "rgba(255,255,255,0.45)" : "rgba(17,24,39,0.45)" };

    const label = (ev.name ?? "").trim() || (catById.get(ev.categoryId)?.name ?? "未命名");
    const { fill, accent } = eventColorFamily(ev.categoryId, ev.id, isDark);
    return { label, fill, accent };
  }

  /** ===== Stats (Overview / Day / Week / Month) ===== */
  // day aggregates
  const dayAgg = useMemo(() => aggregateDays([day!], eventById), [day, eventById]);

  const dayCatStats = useMemo(() => {
    const rows = topNFromMap(dayAgg.byCat, 999).map((r) => {
      const catName = catById.get(r.id)?.name ?? "未分类";
      return { catId: r.id, label: catName, minutes: r.minutes, color: categoryAccent(r.id, isDark) };
    });
    return rows;
  }, [dayAgg, catById, isDark]);

  const dayEventStats = useMemo(() => {
    const rows = topNFromMap(dayAgg.byEvent, 999).map((r) => {
      const ev = eventById.get(r.id);
      const catName = ev ? catById.get(ev.categoryId)?.name : undefined;
      const label = ev ? formatEventLabel(ev, catName) : "（已删除）";
      const color = ev ? eventColorFamily(ev.categoryId, ev.id, isDark).accent : (isDark ? "rgba(255,255,255,0.40)" : "rgba(17,24,39,0.40)");
      return { eventId: r.id, label, minutes: r.minutes, color };
    });
    return rows;
  }, [dayAgg, eventById, catById, isDark]);

  const filteredDayEventStats = useMemo(() => {
    if (!statsCatFilter) return dayEventStats;
    return dayEventStats.filter((x) => {
      const ev = eventById.get(x.eventId);
      return ev?.categoryId === statsCatFilter;
    });
  }, [dayEventStats, statsCatFilter, eventById]);

  const donutItems = useMemo(() => {
    const top = dayEventStats.slice(0, 6).map((x) => ({ label: x.label, value: x.minutes, color: x.color }));
    const rest = dayEventStats.slice(6).reduce((s, x) => s + x.minutes, 0);
    if (rest > 0) top.push({ label: "其他", value: rest, color: isDark ? "rgba(255,255,255,0.22)" : "rgba(17,24,39,0.14)" });
    return top;
  }, [dayEventStats, isDark]);

  // week + month + overview state
  const [weekBars, setWeekBars] = useState<{ dateKey: string; total: number; parts: { label: string; minutes: number; color: string }[] }[]>([]);
  const [weekAgg, setWeekAgg] = useState<Agg>({ totalMinutes: 0, byCat: new Map(), byEvent: new Map() });

  const [monthDays, setMonthDays] = useState<DayLog[]>([]);
  const [monthAgg, setMonthAgg] = useState<Agg>({ totalMinutes: 0, byCat: new Map(), byEvent: new Map() });

  const [overview, setOverview] = useState<{
    today: Agg;
    week: Agg;
    month: Agg;
    recent7: { dateKey: string; total: number }[];
  } | null>(null);

  useEffect(() => {
    if (tab !== "stats") return;

    (async () => {
      // week
      const startKey = getWeekStartKey(dateKey);
      const weekKeys = Array.from({ length: 7 }, (_, i) => addDays(startKey, i));
      const weekDays = await Promise.all(weekKeys.map((k) => loadOrInitDay(k)));
      const wAgg = aggregateDays(weekDays, eventById);
      setWeekAgg(wAgg);

      // week bars (top 4 per day)
      const perDay = weekDays.map((d, idx) => {
        const agg = aggregateDays([d], eventById);
        const items = topNFromMap(agg.byEvent, 999)
          .map((x) => {
            const ev = eventById.get(x.id);
            const catName = ev ? catById.get(ev.categoryId)?.name : undefined;
            const label = ev ? formatEventLabel(ev, catName) : "（已删除）";
            const color = ev ? eventColorFamily(ev.categoryId, ev.id, isDark).accent : (isDark ? "rgba(255,255,255,0.22)" : "rgba(17,24,39,0.12)");
            return { label, minutes: x.minutes, color };
          })
          .sort((a, b) => b.minutes - a.minutes);

        const top = items.slice(0, 4);
        const rest = items.slice(4).reduce((s, x) => s + x.minutes, 0);
        if (rest > 0) top.push({ label: "其他", minutes: rest, color: isDark ? "rgba(255,255,255,0.22)" : "rgba(17,24,39,0.12)" });

        return { dateKey: weekKeys[idx], total: agg.totalMinutes, parts: top };
      });
      setWeekBars(perDay);

      // month
      const mKeys = getMonthKeys(dateKey);
      const mDays = await Promise.all(mKeys.map((k) => loadOrInitDay(k)));
      setMonthDays(mDays);
      setMonthAgg(aggregateDays(mDays, eventById));

      // overview: today/week/month + recent7 totals
      const todayAgg = aggregateDays([await loadOrInitDay(dateKey)], eventById);
      const recent7Keys = Array.from({ length: 7 }, (_, i) => addDays(dateKey, -6 + i));
      const recent7Days = await Promise.all(recent7Keys.map((k) => loadOrInitDay(k)));
      const recent7 = recent7Days.map((d) => ({ dateKey: d.dateKey, total: aggregateDays([d], eventById).totalMinutes }));
      setOverview({ today: todayAgg, week: wAgg, month: aggregateDays(mDays, eventById), recent7 });
    })();
  }, [tab, dateKey, eventById, catById, isDark]);

  function fmtHM(mins: number) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }

  function renderTopCat(agg: Agg) {
    const top = topNFromMap(agg.byCat, 1)[0];
    if (!top) return { label: "—", sub: "" };
    const name = catById.get(top.id)?.name ?? "未分类";
    const pct = agg.totalMinutes > 0 ? Math.round((top.minutes / agg.totalMinutes) * 100) : 0;
    return { label: name, sub: `${pct}%` };
  }
  function renderTopEvent(agg: Agg) {
    const top = topNFromMap(agg.byEvent, 1)[0];
    if (!top) return { label: "—", sub: "" };
    const ev = eventById.get(top.id);
    const catName = ev ? catById.get(ev.categoryId)?.name : undefined;
    const label = ev ? formatEventLabel(ev, catName) : "（已删除）";
    const pct = agg.totalMinutes > 0 ? Math.round((top.minutes / agg.totalMinutes) * 100) : 0;
    return { label, sub: `${pct}%` };
  }

  // ===== Month heatmap layout =====
  const monthGrid = useMemo(() => {
    const startKey = getMonthStartKey(dateKey);
    const startDate = dayKeyToDate(startKey);
    // Monday-based weekday index: Mon=0..Sun=6
    const jsDay = startDate.getDay(); // Sun=0..Sat=6
    const monIdx = (jsDay + 6) % 7;

    const n = getDaysInMonth(dateKey);
    const cells: { dateKey: string | null; dayNum: number | null }[] = [];

    for (let i = 0; i < monIdx; i++) cells.push({ dateKey: null, dayNum: null });
    for (let d = 1; d <= n; d++) {
      const k = addDays(startKey, d - 1);
      cells.push({ dateKey: k, dayNum: d });
    }
    // pad to full weeks
    while (cells.length % 7 !== 0) cells.push({ dateKey: null, dayNum: null });

    const rows = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [dateKey]);

  const monthTotalsByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of monthDays) m.set(d.dateKey, aggregateDays([d], eventById).totalMinutes);
    return m;
  }, [monthDays, eventById]);

  const monthMax = useMemo(() => {
    let mx = 0;
    for (const v of monthTotalsByDay.values()) mx = Math.max(mx, v);
    return mx;
  }, [monthTotalsByDay]);

  // ===== Record page helper =====
  const ready = !!settings && !!day;
  const showBoot = !ready || booting;

  return (
    <div className="app-shell" style={styles.app} onPointerUp={onPointerUp} onPointerMove={onGridPointerMove}>
          {showBoot ? (
      <BootScreen isDark={ready ? isDark : false} />
    ) : (
      <>
      <Header
        key={isDark ? "dark" : "light"}
        current={tab}
        onChange={(t) => {
          setTab(t);
          if (t === "stats") setStatsMode("overview");
        }}
        dateKey={dateKey}
        onPrevDay={() => setDateKey((k) => addDays(k, -1))}
        onNextDay={() => setDateKey((k) => addDays(k, 1))}
        onToday={() => setDateKey(toDateKey())}
        theme={theme}
        isDark={isDark}
      />

      {tab === "record" && (
        <div
          style={styles.page}
          onPointerDown={(e) => {
            const target = e.target as HTMLElement;
            if (isClickInsideNoClear(target)) return;
            if (target.closest("[data-slot]")) return;
            clearSelection();
          }}
        >
          <div style={styles.sectionTitleRow}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <h2 style={styles.h2}>记录</h2>
              <div style={styles.subtle}>08:00 → 次日 08:00 · 15m</div>
            </div>

            <button style={styles.btnGhost} onClick={copyFixedFromPrevDay} title="只复制昨天标为“固定”的事件，且只填空白">
              复制固定
            </button>
          </div>

          {/* ✅ Quick chips (fix: no-clear) */}
          <div data-noclear="true" style={styles.chipsScroll}>
            {recentEvents.map((eid) => {
              const ev = eventById.get(eid);
              if (!ev) return null;

              const catName = catById.get(ev.categoryId)?.name ?? "未分类";
              const shortLabel = ev.name && ev.name.trim() ? ev.name.trim() : catName;

              const { accent } = eventColorFamily(ev.categoryId, ev.id, isDark);

              return (
                <button
                  key={eid}
                  data-noclear="true"
                  style={{
                    ...styles.chip,
                    background: theme.chipBg,
                    border: `1px solid ${accent}`,
                    opacity: selected.size === 0 ? 0.7 : 1,
                  }}
                  disabled={selected.size === 0}
                  onClick={() => applyEvent(eid)}
                  title="应用到选中格子"
                >
                  <span style={{ ...styles.dot, background: accent }} />
                  {shortLabel}
                </button>
              );
            })}
          </div>

          {/* Grid */}
          <div style={styles.gridWrap}>
            {gridRows.map((row, r) => {
              const rowStart = r * 8;
              const rowEnd = rowStart + 8;

              const rowStartSlot = row[0];
              const leftHour = slotToTime(rowStartSlot);
              const rightHour = slotToTime(rowStartSlot + 4);

              const showNowInThisRow = nowSlot != null && nowSlot >= rowStart && nowSlot < rowEnd;
              const nowCol = showNowInThisRow ? nowSlot! - rowStart : 0;
              const nowLeftPct = (nowCol / 8) * 100;

              const rowSegments = globalSegments
                .map((g) => {
                  const start = Math.max(g.start, rowStart);
                  const end = Math.min(g.end, rowEnd);
                  if (start >= end) return null;

                  const startCol = start - rowStart;
                  const len = end - start;

                  const isStartHere = start === g.start;
                  const isEndHere = end === g.end;

                  return {
                    eventId: g.eventId,
                    totalLen: g.len,
                    startCol,
                    len,
                    isStartHere,
                    isEndHere,
                  };
                })
                .filter(Boolean) as {
                eventId: string;
                totalLen: number;
                startCol: number;
                len: number;
                isStartHere: boolean;
                isEndHere: boolean;
              }[];

              return (
                <div key={r} style={styles.rowWrap}>
                  <div style={styles.hourRail} data-noclear="true">
                    <div style={styles.hourTick}>{leftHour}</div>
                    <div style={styles.hourTickRight}>{rightHour}</div>
                  </div>

                  <div style={styles.gridRow}>
                    {row.map((slotIdx) => {
                      const isSel = selected.has(slotIdx);
                      return (
                        <div
                          key={slotIdx}
                          data-slot={slotIdx}
                          onPointerDown={(e) => onCellPointerDown(e, slotIdx)}
                          style={{
                            ...styles.cell,
                            background: isSel ? theme.blue : theme.panel,
                            borderColor: isSel ? theme.blueLine : theme.hairline,
                            transform: isSel ? "scale(0.985)" : "scale(1)",
                          }}
                        />
                      );
                    })}

                    <div style={styles.rowOverlay}>
                      {showNowInThisRow && (
                        <>
                          <div style={{ ...styles.nowLine, left: `calc(${nowLeftPct}% + 6px)` }} />
                          <div style={{ ...styles.nowDot, left: `calc(${nowLeftPct}% + 6px)` }} />
                        </>
                      )}

                      {rowSegments.map((seg, idx) => {
                        const { label, fill, accent } = getEventLabelAndColor(seg.eventId);
                        const minutes = seg.totalLen * SLOT_MINUTES;

                        const leftPct = (seg.startCol / 8) * 100;
                        const widthPct = (seg.len / 8) * 100;

                        const R = 14;
                        const roundLeft = seg.isStartHere ? R : 0;
                        const roundRight = seg.isEndHere ? R : 0;

                        const showTextHere = seg.isStartHere;

                        return (
                          <div
                            key={idx}
                            style={{
                              ...styles.segBlock,
                              left: `calc(${leftPct}% + 6px)`,
                              width: `calc(${widthPct}% - 12px)`,
                              background: fill,
                              borderTopLeftRadius: roundLeft,
                              borderBottomLeftRadius: roundLeft,
                              borderTopRightRadius: roundRight,
                              borderBottomRightRadius: roundRight,
                            }}
                          >
                            <div style={{ ...styles.segDot, background: accent }} />
                            {showTextHere && (
                              <div style={styles.segBlockText}>
                                {label}
                                <span style={styles.segBlockMeta}> · {minutes}m</span>
                              </div>
                            )}
                            <div style={styles.segBlockInnerGlow} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ height: 110 }} />

          {selectionInfo && (
            <div style={styles.sheetWrap} data-noclear="true">
              <div style={styles.sheetHandle} />
              <div style={styles.sheetTop}>
                <div style={styles.sheetTitle}>
                  {selectionInfo.startTime} – {selectionInfo.endTime}
                </div>
                <div style={styles.sheetSub}>
                  {selectionInfo.minutes} 分钟 · {selected.size} 格
                </div>
              </div>

              <div style={styles.sheetBtns}>
                <button
                  style={styles.primaryBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPicker(true);
                    hapticLight();
                  }}
                >
                  标注
                </button>
                <button
                  style={styles.dangerBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    applyEvent(null);
                  }}
                >
                  清空
                </button>
                <button
                  style={styles.secondaryBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    clearSelection();
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {showPicker && (
            <EventPickerModal
              categories={categories}
              events={events}
              recentEvents={recentEvents}
              eventById={eventById}
              catById={catById}
              onClose={() => setShowPicker(false)}
              onPick={async (eventId) => {
                await applyEvent(eventId);
                setShowPicker(false);
              }}
              isDark={isDark}
            />
          )}
        </div>
      )}

      {tab === "stats" && (
        <div style={styles.page}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h2 style={styles.h2}>统计</h2>
            <div style={styles.subtle}>{dateKey}</div>
          </div>

          {/* Stats mode tabs */}
          <div
            data-noclear="true"
            style={{
              display: "flex",
              gap: 6,
              padding: 6,
              borderRadius: 999,
              border: `1px solid ${theme.hairline}`,
              background: isDark ? "rgba(255,255,255,0.06)" : "rgba(17,24,39,0.05)",
              marginBottom: 12,
              width: "fit-content",
            }}
          >
            <Pill active={statsMode === "overview"} onClick={() => setStatsMode("overview")} theme={theme}>
              Overview
            </Pill>
            <Pill active={statsMode === "day"} onClick={() => setStatsMode("day")} theme={theme}>
              日
            </Pill>
            <Pill active={statsMode === "week"} onClick={() => setStatsMode("week")} theme={theme}>
              周
            </Pill>
            <Pill active={statsMode === "month"} onClick={() => setStatsMode("month")} theme={theme}>
              月
            </Pill>
          </div>

          {/* Overview */}
          {statsMode === "overview" && overview && (
            <>
              <div style={styles.card}>
                <div style={styles.cardTitle}>总览</div>
                <div style={styles.subtle}>快速看懂：今天 / 本周 / 本月</div>

                <div style={{ height: 10 }} />

                <div style={{ display: "grid", gap: 10 }}>
                  {[
                    { title: "Today", agg: overview.today },
                    { title: "This Week", agg: overview.week },
                    { title: "This Month", agg: overview.month },
                  ].map((x) => {
                    const topCat = renderTopCat(x.agg);
                    const topEv = renderTopEvent(x.agg);
                    return (
                      <div
                        key={x.title}
                        style={{
                          border: `1px solid ${theme.hairline}`,
                          borderRadius: 18,
                          padding: 12,
                          background: isDark ? "rgba(255,255,255,0.03)" : "rgba(17,24,39,0.03)",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                          <div style={{ fontWeight: 1000, letterSpacing: -0.2 }}>{x.title}</div>
                          <div style={{ fontWeight: 1000 }}>{fmtHM(x.agg.totalMinutes)}</div>
                        </div>

                        <div style={{ height: 8 }} />

                        <div style={{ display: "grid", gap: 6 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <div style={styles.subtle}>Top Category</div>
                            <div style={{ fontWeight: 950 }}>
                              {topCat.label} <span style={{ opacity: 0.7 }}>{topCat.sub}</span>
                            </div>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                            <div style={styles.subtle}>Top Event</div>
                            <div style={{ fontWeight: 950, maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {topEv.label} <span style={{ opacity: 0.7 }}>{topEv.sub}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ height: 14 }} />

                <div style={{ fontWeight: 950, marginBottom: 8 }}>最近 7 天</div>
                <div style={{ display: "grid", gap: 8 }}>
                  {overview.recent7.map((d) => {
                    const pct = Math.min(1, monthMax > 0 ? d.total / Math.max(monthMax, 1) : 0);
                    const barBg = isDark ? "rgba(255,255,255,0.10)" : "rgba(17,24,39,0.08)";
                    const fill = isDark ? "rgba(255,255,255,0.24)" : "rgba(17,24,39,0.22)";
                    return (
                      <div key={d.dateKey} style={{ display: "grid", gridTemplateColumns: "86px 1fr 70px", gap: 10, alignItems: "center" }}>
                        <button
                          style={{ ...styles.btnGhost, padding: "8px 10px" }}
                          onClick={() => {
                            setDateKey(d.dateKey);
                            setStatsMode("day");
                          }}
                        >
                          {d.dateKey.slice(5)}
                        </button>
                        <div style={{ height: 10, borderRadius: 999, background: barBg, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${pct * 100}%`, background: fill }} />
                        </div>
                        <div style={{ textAlign: "right", fontWeight: 950, opacity: 0.8 }}>{Math.round((d.total / 60) * 10) / 10}h</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Day */}
          {statsMode === "day" && (
            <div style={styles.card}>
              <div style={styles.cardTitle}>本日（{dateKey}）</div>

              <div style={styles.statsGrid}>
                <div>
                  <DonutChart items={donutItems} size={220} isDark={isDark} />

                  <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                    {donutItems.map((it) => (
                      <div key={it.label} style={{ display: "grid", gridTemplateColumns: "14px 1fr 70px", gap: 8, alignItems: "center" }}>
                        <div style={{ width: 12, height: 12, borderRadius: 4, background: it.color }} />
                        <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: theme.text }}>
                          {it.label}
                        </div>
                        <div style={{ fontSize: 13, textAlign: "right", color: theme.text, fontWeight: 950 }}>
                          {Math.floor(it.value / 60)}h {it.value % 60}m
                        </div>
                      </div>
                    ))}

                    <div style={{ height: 14 }} />

                    <div style={{ fontWeight: 950, marginBottom: 8, color: theme.text }}>一级分配（宏观）</div>
                    {dayCatStats.length === 0 ? (
                      <div style={styles.subtle}>今日还没有记录。</div>
                    ) : (
                      <div style={{ display: "grid", gap: 8 }}>
                        {dayCatStats.map((r) => {
                          const active = statsCatFilter === r.catId;
                          return (
                            <button
                              key={r.catId}
                              onClick={() => setStatsCatFilter(active ? null : r.catId)}
                              style={{
                                ...styles.btnGhost,
                                display: "grid",
                                gridTemplateColumns: "14px 1fr 90px",
                                gap: 10,
                                alignItems: "center",
                                textAlign: "left",
                                background: active
                                  ? isDark
                                    ? "rgba(255,255,255,0.06)"
                                    : "rgba(17,24,39,0.05)"
                                  : theme.panel,
                              }}
                            >
                              <div style={{ width: 12, height: 12, borderRadius: 4, background: r.color }} />
                              <div style={{ fontWeight: 950, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {r.label}
                                {active ? "（筛选中）" : ""}
                              </div>
                              <div style={{ textAlign: "right", fontWeight: 950 }}>
                                {Math.floor(r.minutes / 60)}h {r.minutes % 60}m
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    <div style={{ height: 14 }} />

                    <div style={{ fontWeight: 950, marginBottom: 8, color: theme.text }}>
                      二级明细（微观）{statsCatFilter ? " · 已按一级筛选" : ""}
                    </div>
                    <div style={{ display: "grid", gap: 6 }}>
                      {filteredDayEventStats.length === 0 ? (
                        <div style={styles.subtle}>没有明细。</div>
                      ) : (
                        filteredDayEventStats.slice(0, 12).map((it) => (
                          <div
                            key={it.eventId}
                            style={{ display: "grid", gridTemplateColumns: "14px 1fr 90px", gap: 8, alignItems: "center" }}
                          >
                            <div style={{ width: 12, height: 12, borderRadius: 4, background: it.color }} />
                            <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: theme.text }}>
                              {it.label}
                            </div>
                            <div style={{ fontSize: 13, textAlign: "right", color: theme.text, fontWeight: 900 }}>
                              {Math.floor(it.minutes / 60)}h {it.minutes % 60}m
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Week */}
          {statsMode === "week" && (
            <div style={styles.card}>
              <div style={styles.cardTitle}>本周（周一～周日）</div>
              <div style={styles.subtle}>总计：{Math.round((weekAgg.totalMinutes / 60) * 10) / 10}h</div>

              <div style={{ marginTop: 12 }}>
                <WeekStackBar days={weekBars} isDark={isDark} />
              </div>

              <div style={{ height: 12 }} />

              <div style={{ fontWeight: 950, marginBottom: 8 }}>一级分配</div>
              <div style={{ display: "grid", gap: 8 }}>
                {topNFromMap(weekAgg.byCat, 8).map((r) => {
                  const catName = catById.get(r.id)?.name ?? "未分类";
                  return (
                    <div key={r.id} style={styles.statRow}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                        <span style={{ width: 10, height: 10, borderRadius: 4, background: categoryAccent(r.id, isDark), flex: "0 0 auto" }} />
                        <div style={styles.statLabel}>{catName}</div>
                      </div>
                      <div style={styles.statValue}>{fmtHM(r.minutes)}</div>
                    </div>
                  );
                })}
              </div>

              <div style={{ height: 12 }} />

              <div style={{ fontWeight: 950, marginBottom: 8 }}>二级 Top 10</div>
              <div style={{ display: "grid", gap: 8 }}>
                {topNFromMap(weekAgg.byEvent, 10).map((r) => {
                  const ev = eventById.get(r.id);
                  const catName = ev ? catById.get(ev.categoryId)?.name : undefined;
                  const label = ev ? formatEventLabel(ev, catName) : "（已删除）";
                  const color = ev ? eventColorFamily(ev.categoryId, ev.id, isDark).accent : (isDark ? "rgba(255,255,255,0.22)" : "rgba(17,24,39,0.12)");
                  return (
                    <div key={r.id} style={styles.statRow}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                        <span style={{ width: 10, height: 10, borderRadius: 4, background: color, flex: "0 0 auto" }} />
                        <div style={styles.statLabel}>{label}</div>
                      </div>
                      <div style={styles.statValue}>{fmtHM(r.minutes)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Month */}
          {statsMode === "month" && (
            <div style={styles.card}>
              <div style={styles.cardTitle}>本月</div>
              <div style={styles.subtle}>
                总计：{Math.round((monthAgg.totalMinutes / 60) * 10) / 10}h · 点击某天跳转到日统计
              </div>

              <div style={{ height: 10 }} />

              {/* Month heatmap */}
              <div
                style={{
                  border: `1px solid ${theme.hairline}`,
                  borderRadius: 18,
                  overflow: "hidden",
                  background: isDark ? "rgba(255,255,255,0.03)" : "rgba(17,24,39,0.03)",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(7, 1fr)",
                    gap: 0,
                    borderBottom: `1px solid ${theme.hairline}`,
                    background: theme.panel,
                  }}
                >
                  {["一", "二", "三", "四", "五", "六", "日"].map((w) => (
                    <div key={w} style={{ padding: "8px 10px", fontSize: 12, fontWeight: 950, color: theme.sub, textAlign: "center" }}>
                      {w}
                    </div>
                  ))}
                </div>

                <div style={{ display: "grid", gap: 0 }}>
                  {monthGrid.map((row, ridx) => (
                    <div key={ridx} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
                      {row.map((cell, cidx) => {
                        if (!cell.dateKey) {
                          return (
                            <div
                              key={cidx}
                              style={{
                                minHeight: 44,
                                borderRight: cidx === 6 ? "none" : `1px solid ${theme.hairline}`,
                                borderBottom: `1px solid ${theme.hairline}`,
                                background: theme.panel,
                              }}
                            />
                          );
                        }

                        const total = monthTotalsByDay.get(cell.dateKey) ?? 0;
                        const t = monthMax > 0 ? total / monthMax : 0;
                        const alpha = total === 0 ? 0 : Math.min(0.85, 0.12 + t * 0.73);

                        const isToday = cell.dateKey === toDateKey();

                        return (
                          <button
                            key={cidx}
                            onClick={() => {
                              setDateKey(cell.dateKey!);
                              setStatsMode("day");
                            }}
                            style={{
                              minHeight: 44,
                              borderRight: cidx === 6 ? "none" : `1px solid ${theme.hairline}`,
                              borderBottom: `1px solid ${theme.hairline}`,
                              background: theme.panel,
                              cursor: "pointer",
                              padding: 10,
                              textAlign: "left",
                              position: "relative",
                            }}
                            title={`${cell.dateKey} · ${Math.round((total / 60) * 10) / 10}h`}
                          >
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                              <div style={{ fontWeight: 1000, color: theme.text }}>{cell.dayNum}</div>
                              <div style={{ fontSize: 11, color: theme.sub, fontWeight: 900 }}>
                                {total > 0 ? `${Math.round((total / 60) * 10) / 10}h` : ""}
                              </div>
                            </div>

                            <div
                              style={{
                                marginTop: 6,
                                height: 8,
                                borderRadius: 999,
                                background: isDark ? "rgba(255,255,255,0.08)" : "rgba(17,24,39,0.07)",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  height: "100%",
                                  width: `${Math.min(100, (t * 100) || 0)}%`,
                                  background: isDark ? `rgba(255,255,255,${alpha})` : `rgba(17,24,39,${alpha})`,
                                }}
                              />
                            </div>

                            {isToday && (
                              <div
                                style={{
                                  position: "absolute",
                                  inset: 6,
                                  borderRadius: 14,
                                  border: `1px solid ${isDark ? "rgba(255,255,255,0.22)" : "rgba(17,24,39,0.16)"}`,
                                  pointerEvents: "none",
                                }}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ height: 14 }} />

              <div style={{ fontWeight: 950, marginBottom: 8 }}>一级分配 Top 8</div>
              <div style={{ display: "grid", gap: 8 }}>
                {topNFromMap(monthAgg.byCat, 8).map((r) => {
                  const catName = catById.get(r.id)?.name ?? "未分类";
                  return (
                    <div key={r.id} style={styles.statRow}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, overflow: "hidden" }}>
                        <span style={{ width: 10, height: 10, borderRadius: 4, background: categoryAccent(r.id, isDark), flex: "0 0 auto" }} />
                        <div style={styles.statLabel}>{catName}</div>
                      </div>
                      <div style={styles.statValue}>{fmtHM(r.minutes)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
       
      )}

      {tab === "more" && (
        <div style={{ ...styles.page, width: "100%", boxSizing: "border-box" }}>
          <h2 style={styles.h2}>更多</h2>

          <div style={styles.card}>
            <div style={styles.cardTitle}>外观</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
              <div style={styles.subtle}>主题</div>
              <select
                value={settings?.themeMode ?? "system"}
                onChange={(e) => setSettings((s) => (s ? { ...s, themeMode: e.target.value as ThemeMode } : s))}
                style={styles.select}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </div>
          </div>

          <div style={{ height: 12 }} />

          <div style={styles.card}>
            <div style={styles.cardTitle}>夜间范围（用于“一键填充睡觉”）</div>
            <div style={styles.subtle}>UI 始终显示 15m 格子；此处仅影响填充逻辑。</div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
              <label style={styles.inlineLabel}>
                起：
                <input
                  type="time"
                  value={settings?.nightStart ?? "23:00"}
                  onChange={(e) => setSettings((s) => (s ? { ...s, nightStart: e.target.value } : s))}
                  style={styles.time}
                />
              </label>

              <label style={styles.inlineLabel}>
                止：
                <input
                  type="time"
                  value={settings?.nightEnd ?? "08:00"}
                  onChange={(e) => setSettings((s) => (s ? { ...s, nightEnd: e.target.value } : s))}
                  style={styles.time}
                />
              </label>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <button style={styles.primaryBtn} onClick={() => fillSleep(false)}>
                填充睡觉（不覆盖）
              </button>
              <button style={styles.secondaryBtn} onClick={() => fillSleep(true)}>
                填充睡觉（覆盖）
              </button>
            </div>
          </div>

          <div style={{ height: 12 }} />

          <div style={styles.card}>
            <div style={styles.cardTitle}>事件管理（一级 / 二级）</div>
            <div style={styles.subtle}>二级可空（仅一级）。支持“固定”以便复制昨天固定事件。</div>

            <div style={styles.formsGrid}>
              <AddCategory onAdd={addCategory} styles={styles} />
              <AddEvent categories={categories} onAdd={addEvent} styles={styles} />
            </div>

            <div style={{ height: 12 }} />

            <div style={{ display: "grid", gap: 10 }}>
              {categories.map((c) => {
                const evs = events.filter((e) => e.categoryId === c.id);
                return (
                  <div key={c.id} style={styles.groupCard}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                      <div style={{ fontWeight: 950, color: theme.text }}>{c.name}</div>
                      <button style={styles.secondaryBtn} onClick={() => deleteCategory(c.id)}>
                        删除一级
                      </button>
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
                      {evs.map((ev) => {
                        const label = formatEventLabel(ev, c.name);
                        const { accent } = eventColorFamily(ev.categoryId, ev.id, isDark);
                        return (
                          <div key={ev.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <button
                              data-noclear="true"
                              style={{
                                ...styles.chip,
                                background: theme.chipBg,
                                border: `1px solid ${accent}`,

                                color: theme.text,
                              }}
                              onClick={() => {
                                if (selected.size > 0) applyEvent(ev.id);
                                else {
                                  setRecentEvents((prev) => {
                                    const filtered = prev.filter((x) => x !== ev.id);
                                    return [ev.id, ...filtered].slice(0, RECENT_LIMIT);
                                  });
                                }
                              }}
                              title={selected.size > 0 ? "应用到选中格子" : "加入最近事件"}
                            >
                              <span style={{ ...styles.dot, background: accent }} />
                              {label}
                            </button>

                            <label style={{ ...styles.inlineSmall, color: theme.sub }}>
                              <input
                                type="checkbox"
                                checked={!!ev.fixed}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setEvents((prev) => prev.map((x) => (x.id === ev.id ? { ...x, fixed: checked } : x)));
                                }}
                              />
                              固定
                            </label>

                            <button style={styles.iconBtn} onClick={() => deleteEvent(ev.id)} title="删除事件">
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ height: 12 }} />

          <div style={styles.card}>
            <div style={styles.cardTitle}>数据</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
              <button style={styles.primaryBtn} onClick={exportJSON}>
                导出 JSON
              </button>

              <label style={{ ...styles.secondaryBtn, cursor: "pointer" }}>
                导入 JSON
                <input
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importJSON(f);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
          </div>
        </div>
      )}
       </>
      )}
    </div>
  );
}

/** ===== Header ===== */
function Header(props: {
  current: Tab;
  onChange: (t: Tab) => void;
  dateKey: string;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
  theme: ReturnType<typeof makeThemeTokens>;
  isDark: boolean;
}) {
  const { current, onChange, dateKey, onPrevDay, onNextDay, onToday, theme, isDark } = props;

  return (
    <div
      style={{
        ...headerStyles.header,
        background: theme.headerBg,
        borderBottom: `1px solid ${theme.hairline}`,
      }}
      data-noclear="true"
    >
      <div style={headerStyles.topRow}>
        <div style={headerStyles.brandRow}>
          <div
            style={{
              ...headerStyles.logo,
              border: `1px solid ${theme.hairline}`,
              background: isDark ? "rgba(255,255,255,0.06)" : "rgba(17,24,39,0.04)",
            }}
          >
            <div style={headerStyles.logoGrid} />
          </div>

          <div style={headerStyles.brandLine}>
            <span style={{ ...headerStyles.brand, color: theme.text }}>日格 DayGrid</span>
            <span style={{ ...headerStyles.brandDot, color: theme.sub }}>·</span>
            <span style={{ ...headerStyles.brandSub, color: theme.sub }}>让每 15 分钟更清晰</span>
          </div>
        </div>

        <div
          style={{
            ...headerStyles.tabsWrap,
            background: isDark ? "rgba(255,255,255,0.06)" : "rgba(17,24,39,0.05)",
            border: `1px solid ${theme.hairline}`,
          }}
        >
          <SegButton active={current === "record"} onClick={() => onChange("record")} theme={theme}>
            记录
          </SegButton>
          <SegButton active={current === "stats"} onClick={() => onChange("stats")} theme={theme}>
            统计
          </SegButton>
          <SegButton active={current === "more"} onClick={() => onChange("more")} theme={theme}>
            更多
          </SegButton>
        </div>
      </div>

      <div style={headerStyles.dateRow}>
        <button style={{ ...headerStyles.icon, color: theme.text, border: `1px solid ${theme.hairline}`, background: theme.panel }} onClick={onPrevDay}>
          ◀
        </button>
        <div style={{ ...headerStyles.date, color: theme.text }}>{dateKey}</div>
        <button style={{ ...headerStyles.icon, color: theme.text, border: `1px solid ${theme.hairline}`, background: theme.panel }} onClick={onNextDay}>
          ▶
        </button>
        <button style={{ ...headerStyles.today, color: theme.text, border: `1px solid ${theme.hairline}`, background: theme.panel }} onClick={onToday}>
          今日
        </button>
      </div>
    </div>
  );
}

function SegButton(props: { active: boolean; onClick: () => void; children: React.ReactNode; theme: ReturnType<typeof makeThemeTokens> }) {
  const { active, onClick, children, theme } = props;
  return (
    <button
      onClick={onClick}
      style={{
        ...headerStyles.segBtn,
        background: active ? theme.panel : "transparent",
        color: theme.text,
        boxShadow: active ? theme.shadow : "none",
        border: active ? `1px solid ${theme.hairline}` : "1px solid transparent",
        transform: active ? "translateY(-0.5px)" : "translateY(0)",
        transition: "transform 140ms ease, box-shadow 140ms ease, background 140ms ease",
      }}
    >
      {children}
    </button>
  );
}

function Pill(props: { active: boolean; onClick: () => void; children: React.ReactNode; theme: ReturnType<typeof makeThemeTokens> }) {
  const { active, onClick, children, theme } = props;
  return (
    <button
      onClick={onClick}
      style={{
        height: 34,
        padding: "0 14px",
        borderRadius: 999,
        cursor: "pointer",
        fontWeight: 950,
        background: active ? theme.panel : "transparent",
        color: theme.text,
        boxShadow: active ? theme.shadow : "none",
        border: active ? `1px solid ${theme.hairline}` : "1px solid transparent",
        transform: active ? "translateY(-0.5px)" : "translateY(0)",
        transition: "transform 140ms ease, box-shadow 140ms ease, background 140ms ease",
      }}
    >
      {children}
    </button>
  );
}

/** ===== Small forms ===== */
function AddCategory({ onAdd, styles }: { onAdd: (name: string) => void; styles: Record<string, React.CSSProperties> }) {
  const [name, setName] = useState("");
  return (
    <div style={styles.miniCard}>
      <div style={styles.miniTitle}>新增一级</div>
      <div style={{ display: "flex", gap: 10 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：运动" style={styles.input} />
        <button
          style={styles.primaryBtn}
          onClick={() => {
            onAdd(name);
            setName("");
          }}
        >
          添加
        </button>
      </div>
    </div>
  );
}

function AddEvent({
  categories,
  onAdd,
  styles,
}: {
  categories: Category[];
  onAdd: (categoryId: string, name: string) => void;
  styles: Record<string, React.CSSProperties>;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!categoryId && categories[0]?.id) setCategoryId(categories[0].id);
  }, [categories, categoryId]);

  return (
    <div style={styles.miniCard}>
      <div style={styles.miniTitle}>新增二级</div>
      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} style={styles.select}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：PPT" style={styles.input} />
        <button
          style={styles.primaryBtn}
          onClick={() => {
            if (!categoryId) return;
            const trimmed = name.trim();
            if (!trimmed) {
              alert("请填写二级名称（必填）");
              return;
            }
            onAdd(categoryId, trimmed);
            setName("");
          }}
        >
          添加
        </button>
      </div>
    </div>
  );
}

/** ===== Styles ===== */
function makeStyles(theme: ReturnType<typeof makeThemeTokens>, isDark: boolean) {
  const font = `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial`;
  return {
    app: {
      fontFamily: font,
      background: theme.bg,
      color: theme.text,
      minHeight: "100dvh",
      height: "100dvh",
      width: "100vw",
      maxWidth: "100vw",
      overflowY: "auto",
      overflowX: "hidden",
      padding: 0,
      margin: 0,
      WebkitOverflowScrolling: "touch",
    },

    page: { padding: "0 12px 16px 12px" },

    h2: { margin: "8px 0", fontSize: 18, fontWeight: 950, letterSpacing: -0.2, color: theme.text },

    subtle: { color: theme.sub, fontSize: 13 },

    sectionTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 },

    card: {
      border: `1px solid ${theme.hairline}`,
      borderRadius: 20,
      padding: 12,
      background: theme.panel,
      boxShadow: isDark ? "0 10px 24px rgba(0,0,0,0.40)" : "0 10px 16px rgba(0,0,0,0.055)",
    },
    cardTitle: { fontWeight: 950, color: theme.text },

    statsGrid: {
      marginTop: 10,
      display: "grid",
      gridTemplateColumns: "1fr",
      gap: 14,
    },

    chipsScroll: { display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6, WebkitOverflowScrolling: "touch" },

    dot: { width: 10, height: 10, borderRadius: 999, display: "inline-block", marginRight: 8 },

    chip: {
      padding: "8px 10px",
      borderRadius: 999,
      cursor: "pointer",
      whiteSpace: "nowrap",
      fontWeight: 900,
      display: "inline-flex",
      alignItems: "center",
      color: theme.text,
      fontSize: 13,
    },

    gridWrap: {
      marginTop: 12,
      border: `1px solid ${theme.hairline}`,
      borderRadius: 22,
      overflow: "hidden",
      background: theme.panel,
      boxShadow: theme.shadow,
    },

    rowWrap: {
      borderBottom: `1px solid ${theme.hairline}`,
      background: theme.panel,
    },

    hourRail: {
      display: "grid",
      gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
      alignItems: "center",
      height: 26,
      padding: "0 6px",
      background: theme.panel,
      borderBottom: `1px solid ${theme.hairline}`,
    },

    hourTick: {
      gridColumn: "span 4",
      fontSize: 12,
      fontWeight: 900,
      color: theme.sub,
      opacity: 0.95,
      paddingLeft: 4,
    },

    hourTickRight: {
      gridColumn: "span 4",
      fontSize: 12,
      fontWeight: 900,
      color: theme.sub,
      opacity: 0.95,
      paddingLeft: 4,
    },

    gridRow: {
      position: "relative" as const,
      display: "grid",
      gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
    },

    cell: {
      borderLeft: `1px solid ${theme.hairline}`,
      borderTop: `1px solid ${theme.hairline}`,
      minHeight: 44,
      cursor: "pointer",
      userSelect: "none",
      touchAction: "pan-y",
      transition: "background 120ms ease, border-color 120ms ease, transform 120ms ease",
      willChange: "transform",
    },

    rowOverlay: {
      position: "absolute" as const,
      inset: 0,
      pointerEvents: "none" as const,
      zIndex: 2,
    },

    nowLine: {
      position: "absolute" as const,
      top: 6,
      bottom: 6,
      width: 2,
      transform: "translateX(-50%)",
      background: isDark ? "rgba(255,59,48,0.85)" : "rgba(255,59,48,0.78)",
      borderRadius: 999,
      boxShadow: isDark ? "0 6px 18px rgba(255,59,48,0.18)" : "0 6px 18px rgba(255,59,48,0.12)",
      zIndex: 10,
      pointerEvents: "none" as const,
    },

    nowDot: {
      position: "absolute" as const,
      width: 8,
      height: 8,
      borderRadius: 999,
      top: 10,
      transform: "translate(-50%, 0)",
      background: isDark ? "rgba(255,59,48,0.95)" : "rgba(255,59,48,0.9)",
      zIndex: 11,
      pointerEvents: "none" as const,
    },

    segBlock: {
      position: "absolute" as const,
      top: 6,
      bottom: 6,
      overflow: "hidden",
      display: "flex",
      alignItems: "center",
      padding: "8px 10px",
      gap: 8,
      boxShadow: isDark ? "0 10px 22px rgba(0,0,0,0.38)" : "0 10px 16px rgba(0,0,0,0.056)",
      border: `1px solid ${isDark ? "rgba(255,255,255,0.10)" : "rgba(17,24,39,0.10)"}`,
      transition: "transform 140ms ease, opacity 140ms ease",
      willChange: "transform, opacity",
      zIndex: 4,
    },

    segBlockInnerGlow: {
      position: "absolute" as const,
      inset: 0,
      background: isDark
        ? "linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.02))"
        : "linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.04))",
      pointerEvents: "none" as const,
    },

    segDot: {
      width: 8,
      height: 8,
      borderRadius: 999,
      flex: "0 0 auto",
      position: "relative" as const,
      zIndex: 1,
    },

    segBlockText: {
      position: "relative" as const,
      zIndex: 1,
      fontSize: 13,
      fontWeight: 950,
      lineHeight: 1.15,
      color: theme.text,
      display: "-webkit-box",
      WebkitLineClamp: 2,
      WebkitBoxOrient: "vertical" as const,
      overflow: "hidden",
    },

    segBlockMeta: {
      opacity: 0.72,
      fontWeight: 900,
      marginLeft: 2,
    },

    sheetWrap: {
      position: "fixed" as const,
      left: 12,
      right: 12,
      bottom: 12,
      zIndex: 999,
      borderRadius: 22,
      padding: 14,
      background: theme.panel,
      boxShadow: isDark ? "0 22px 60px rgba(0,0,0,0.70)" : "0 22px 60px rgba(0,0,0,0.18)",
      border: `1px solid ${theme.hairline}`,
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      transform: "translateZ(0)",
    },

    sheetHandle: {
      width: 46,
      height: 5,
      borderRadius: 999,
      margin: "0 auto 10px auto",
      background: isDark ? "rgba(255,255,255,0.18)" : "rgba(17,24,39,0.12)",
    },

    sheetTop: { display: "grid", gap: 2, marginBottom: 12 },

    sheetTitle: { fontWeight: 950, fontSize: 16, color: theme.text },

    sheetSub: { fontSize: 13, color: theme.sub },

    sheetBtns: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 },

    primaryBtn: {
      padding: "12px 14px",
      borderRadius: 16,
      border: `1px solid ${theme.hairline}`,
      background: theme.text,
      color: theme.bg,
      cursor: "pointer",
      fontWeight: 950,
      fontSize: 14,
    },

    secondaryBtn: {
      padding: "12px 14px",
      borderRadius: 16,
      border: `1px solid ${theme.hairline}`,
      background: theme.panel,
      color: theme.text,
      cursor: "pointer",
      fontWeight: 950,
      fontSize: 14,
    },

    dangerBtn: {
      padding: "12px 14px",
      borderRadius: 16,
      border: `1px solid ${theme.hairline}`,
      background: isDark ? "rgba(255,59,48,0.22)" : "rgba(255,59,48,0.14)",
      color: theme.text,
      cursor: "pointer",
      fontWeight: 950,
      fontSize: 14,
    },

    btnGhost: {
      padding: "10px 12px",
      borderRadius: 14,
      border: `1px solid ${theme.hairline}`,
      background: theme.panel,
      color: theme.text,
      cursor: "pointer",
      fontWeight: 950,
      fontSize: 13,
    },

    iconBtn: {
      width: 34,
      height: 34,
      borderRadius: 12,
      border: `1px solid ${theme.hairline}`,
      background: theme.panel,
      color: theme.text,
      cursor: "pointer",
      fontWeight: 950,
      display: "grid",
      placeItems: "center",
    },

    statRow: { display: "grid", gridTemplateColumns: "1fr 110px", gap: 10, alignItems: "center" },

    statLabel: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: theme.text },

    statValue: { textAlign: "right" as const, color: theme.text, fontWeight: 950 },

    miniCard: { border: `1px solid ${theme.hairline}`, borderRadius: 20, padding: 12, background: theme.bg },

    miniTitle: { fontWeight: 950, marginBottom: 10, color: theme.text },

    input: {
      padding: "11px 12px",
      borderRadius: 14,
      border: `1px solid ${theme.hairline}`,
      width: "100%",
      background: theme.panel,
      color: theme.text,
      outline: "none",
    },

    select: {
      padding: "11px 12px",
      borderRadius: 14,
      border: `1px solid ${theme.hairline}`,
      width: "100%",
      background: theme.panel,
      color: theme.text,
      outline: "none",
      fontWeight: 900,
    },

    time: {
      padding: "10px 12px",
      borderRadius: 14,
      border: `1px solid ${theme.hairline}`,
      background: theme.panel,
      color: theme.text,
      outline: "none",
    },

    inlineLabel: { display: "flex", gap: 8, alignItems: "center", color: theme.text, fontWeight: 900 },

    inlineSmall: { display: "flex", gap: 6, alignItems: "center", fontWeight: 900, fontSize: 12 },

    groupCard: {
      border: `1px solid ${theme.hairline}`,
      borderRadius: 20,
      padding: 12,
      background: theme.bg,
    },

    formsGrid: {
      display: "grid",
      gridTemplateColumns: "1fr",
      gap: 12,
      marginTop: 12,
    },
  } satisfies Record<string, React.CSSProperties>;
}

const headerStyles: Record<string, React.CSSProperties> = {
  header: {
    position: "sticky",
    top: 0,
    zIndex: 50,
    padding: `calc(6px + env(safe-area-inset-top, 0px)) 12px 10px 12px`,
    margin: "0 0 8px 0",
    width: "100%",
    boxSizing: "border-box",
    backdropFilter: "blur(14px)",
    WebkitBackdropFilter: "blur(14px)",
    display: "grid",
    gap: 8,
  },

  topRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },

  brandRow: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },

  logo: {
    width: 32,
    height: 32,
    borderRadius: 12,
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    flex: "0 0 auto",
  },
  logoGrid: {
    width: 16,
    height: 16,
    borderRadius: 6,
    background:
      "repeating-linear-gradient(0deg, rgba(0,0,0,0.12), rgba(0,0,0,0.12) 1px, transparent 1px, transparent 4px), repeating-linear-gradient(90deg, rgba(0,0,0,0.12), rgba(0,0,0,0.12) 1px, transparent 1px, transparent 4px)",
    opacity: 0.7,
  },

  brandLine: {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  brand: { fontWeight: 1000, fontSize: 18, letterSpacing: -0.4 },
  brandDot: { fontWeight: 900, opacity: 0.6 },
  brandSub: { fontWeight: 850, fontSize: 13, opacity: 0.9 },

  dateRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  icon: { width: 34, height: 34, borderRadius: 12, cursor: "pointer", fontWeight: 950 },
  today: { height: 34, borderRadius: 12, cursor: "pointer", fontWeight: 950, padding: "0 10px" },
  date: { fontWeight: 950, fontSize: 13, minWidth: 108, textAlign: "center" as const },

  tabsWrap: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    padding: 6,
    borderRadius: 999,
    flex: "0 0 auto",
  },
  segBtn: {
    height: 34,
    padding: "0 14px",
    borderRadius: 999,
    cursor: "pointer",
    fontWeight: 950,
  },
};
