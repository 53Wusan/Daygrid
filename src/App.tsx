import React, { useEffect, useMemo, useRef, useState } from "react";
import localforage from "localforage";

/**
 * DayGrid v1.2 (iOS-like, mobile-first)
 * - 96 slots/day (15m each), displayed as 12 rows x 8 cols (2 hours per row)
 * - Minimal grid: events rendered as "segment blocks" in an overlay layer, so labels can span multiple cells
 * - Hour rail row above each 2-hour row so time ticks never get covered
 * - Selection + bottom action sheet (iOS-like)
 * - Fix: bottom buttons not responding caused by "tap blank to clear selection" — now excluded via data-noclear
 * - Local persistence + quick recent + fixed copy + stats + import/export
 */

type Tab = "record" | "stats" | "more";
type ThemeMode = "system" | "light" | "dark";

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

function colorForSeed(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % 360;
}
function segmentFillColor(seed: string, isDark: boolean) {
  const hue = colorForSeed(seed);
  if (isDark) return `hsla(${hue} 55% 22% / 0.98)`;
  return `hsla(${hue} 75% 92% / 1)`;
}
function segmentAccentColor(seed: string, isDark: boolean) {
  const hue = colorForSeed(seed);
  if (isDark) return `hsla(${hue} 75% 62% / 1)`;
  return `hsla(${hue} 70% 45% / 1)`;
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
    { id: "evt_work_only", categoryId: "cat_work", name: undefined, fixed: false },
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

/** ===== Small SVG charts (simple + stable) ===== */
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

/** ===== Modal ===== */
function EventPickerModal(props: {
  categories: Category[];
  events: EventTag[];
  recentEvents: string[];
  eventById: Map<string, EventTag>;
  catById: Map<string, Category>;
  onClose: () => void;
  onPick: (eventId: string) => void;
  onPickCategoryOnly: (categoryId: string) => void;
  isDark: boolean;
}) {
  const { categories, events, recentEvents, eventById, catById, onClose, onPick, onPickCategoryOnly, isDark } = props;

  const bg = isDark ? "rgba(0,0,0,0.62)" : "rgba(0,0,0,0.35)";
  const panel = isDark ? "#0b0f17" : "#ffffff";
  const border = isDark ? "rgba(255,255,255,0.12)" : "rgba(17,24,39,0.10)";
  const text = isDark ? "#f9fafb" : "#111827";
  const sub = isDark ? "#9ca3af" : "#6b7280";
  const chipBg = isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.92)";

  return (
    <div style={{ ...modalStyles.backdrop, background: bg }} onClick={onClose}>
      <div style={{ ...modalStyles.modal, background: panel, border: `1px solid ${border}` }} onClick={(e) => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <div style={{ fontWeight: 900, color: text, fontSize: 16 }}>选择事件</div>
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
                <div style={modalStyles.groupHeader}>
                  <div style={{ fontWeight: 900, color: text }}>{c.name}</div>
                  <button
                    style={{ ...modalStyles.smallBtn, border: `1px solid ${border}`, background: chipBg, color: text }}
                    onClick={() => onPickCategoryOnly(c.id)}
                  >
                    仅 {c.name}
                  </button>
                </div>

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
  groupHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
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

/** ===== App ===== */
export default function App() {
  const [tab, setTab] = useState<Tab>("record");
  const [dateKey, setDateKey] = useState<string>(toDateKey());
  const [day, setDay] = useState<DayLog | null>(null);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [events, setEvents] = useState<EventTag[]>([]);
  const [recentEvents, setRecentEvents] = useState<string[]>([]);

  // selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isSelecting, setIsSelecting] = useState(false);
  const anchorRef = useRef<number | null>(null);

  // drag/click handling
  const draggedRef = useRef(false);
  const pressSlotRef = useRef<{ start: number } | null>(null);

  // Picker modal
  const [showPicker, setShowPicker] = useState(false);

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
      setIsSelecting(false);
      anchorRef.current = null;
      setShowPicker(false);
      draggedRef.current = false;
      pressSlotRef.current = null;
    })();
  }, [dateKey]);

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

  const themeMode = settings?.themeMode ?? "system";
  const isDark = themeMode === "dark" ? true : themeMode === "light" ? false : systemDark;
  const theme = useMemo(() => makeThemeTokens(isDark), [isDark]);

  const styles = useMemo(() => makeStyles(theme, isDark), [theme, isDark]);

  const eventById = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  // grid: 12 rows x 8 columns (2h per row)
  const gridRows = useMemo(() => Array.from({ length: 12 }, (_, r) => Array.from({ length: 8 }, (_, c) => r * 8 + c)), []);

  // ===== selection helpers =====
  function clearSelection() {
    setSelected(new Set());
  }
  function selectRange(a: number, b: number) {
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    const next = new Set<number>();
    for (let i = min; i <= max; i++) next.add(i);
    setSelected(next);
  }

  function onCellPointerDown(e: React.PointerEvent, startSlot: number) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pressSlotRef.current = { start: startSlot };
    draggedRef.current = false;
    setIsSelecting(false);
    anchorRef.current = null;
  }

  function onGridPointerMove(e: React.PointerEvent) {
    if (e.buttons === 0) return;

    if (!isSelecting) {
      const p = pressSlotRef.current;
      if (!p) return;

      setIsSelecting(true);
      anchorRef.current = p.start;
      setSelected(new Set([p.start]));
    }

    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    if (!el) return;

    const cellEl = el.closest("[data-slot]") as HTMLElement | null;
    if (!cellEl) return;

    const startSlot = Number(cellEl.dataset.slot);
    if (Number.isNaN(startSlot)) return;

    const a = anchorRef.current;
    if (a == null) return;

    draggedRef.current = true;
    selectRange(a, startSlot);
  }

  function onPointerUp() {
    setIsSelecting(false);
    anchorRef.current = null;
    pressSlotRef.current = null;
    setTimeout(() => {
      draggedRef.current = false;
    }, 0);
  }

  function onCellTapToggle(startSlot: number) {
    if (draggedRef.current) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(startSlot)) next.delete(startSlot);
      else next.add(startSlot);
      return next;
    });
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

  function getOrCreateCategoryOnlyEvent(categoryId: string) {
    const existing = events.find((e) => e.categoryId === categoryId && (!e.name || e.name.trim() === ""));
    if (existing) return existing.id;

    const id = uid("evt");
    const newEvt: EventTag = { id, categoryId, name: undefined, fixed: false };
    setEvents((prev) => [...prev, newEvt]);
    setRecentEvents((prev) => [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_LIMIT));
    return id;
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
    const payload = { version: 1, exportedAt: new Date().toISOString(), dateKey, settings, categories, events, recentEvents, day };
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
  function addEvent(categoryId: string, name?: string) {
    const trimmed = (name ?? "").trim();
    setEvents((prev) => [...prev, { id: uid("evt"), categoryId, name: trimmed || undefined, fixed: false }]);
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

  // ===== Stats =====
  const dayStats = useMemo(() => {
    if (!day) return [];
    const count = new Map<string, number>();
    for (const eid of day.slots) {
      if (!eid) continue;
      count.set(eid, (count.get(eid) ?? 0) + 1);
    }
    return Array.from(count.entries())
      .map(([eid, slots]) => {
        const ev = eventById.get(eid);
        const catName = ev ? catById.get(ev.categoryId)?.name : undefined;
        const label = ev ? formatEventLabel(ev, catName) : "（已删除）";
        return { eventId: eid, label, minutes: slots * SLOT_MINUTES, color: segmentAccentColor(label, isDark) };
      })
      .sort((a, b) => b.minutes - a.minutes);
  }, [day, eventById, catById, isDark]);

  const donutItems = useMemo(() => {
    const top = dayStats.slice(0, 6).map((x) => ({ label: x.label, value: x.minutes, color: x.color }));
    const rest = dayStats.slice(6).reduce((s, x) => s + x.minutes, 0);
    if (rest > 0) top.push({ label: "其他", value: rest, color: isDark ? "#6b7280" : "#9ca3af" });
    return top;
  }, [dayStats, isDark]);

  // ===== selection info =====
  const selectionInfo = useMemo(() => {
    if (selected.size === 0) return null;
    const arr = Array.from(selected).sort((a, b) => a - b);
    const start = arr[0];
    const end = arr[arr.length - 1] + 1; // exclusive
    const minutes = arr.length * SLOT_MINUTES;
    return { start, end, minutes, startTime: slotToTime(start), endTime: slotToTime(end) };
  }, [selected]);

  if (!settings || !day) {
    return <div style={{ padding: 16, fontFamily: "system-ui" }}>Loading…</div>;
  }

  // ===== helpers for segments =====
  function getEventLabelAndSeed(eventId: string) {
    const ev = eventById.get(eventId);
    if (!ev) return { label: "（已删除）", seed: "deleted" };
    const catName = catById.get(ev.categoryId)?.name;
    const label = formatEventLabel(ev, catName);
    return { label, seed: label || eventId };
  }

  function isClickInsideNoClear(target: HTMLElement | null) {
    if (!target) return false;
    return !!target.closest("[data-noclear='true']");
  }

  return (
    <div style={styles.app} onPointerUp={onPointerUp} onPointerMove={onGridPointerMove}>
      <Header
        current={tab}
        onChange={setTab}
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
            if (isClickInsideNoClear(target)) return;          // ✅ FIX: bottom sheet / modal triggers won't clear
            if (target.closest("[data-slot]")) return;         // clicking a cell doesn't clear
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

          <div style={styles.quickRow}>
            <div style={styles.subtle}>快速（最近）</div>
            <div style={styles.chipsScroll}>
              {recentEvents.map((eid) => {
                const ev = eventById.get(eid);
                if (!ev) return null;
                const catName = catById.get(ev.categoryId)?.name;
                const label = formatEventLabel(ev, catName);
                const seed = label || eid;
                return (
                  <button
                    key={eid}
                    style={{
                      ...styles.chip,
                      background: theme.chipBg,
                      border: `1px solid ${theme.chipBorder}`,
                      opacity: selected.size === 0 ? 0.7 : 1,
                    }}
                    disabled={selected.size === 0}
                    onClick={() => applyEvent(eid)}
                    title="应用到选中格子"
                  >
                    <span style={{ ...styles.dot, background: segmentAccentColor(seed, isDark) }} />
                    {label || "未命名"}
                  </button>
                );
              })}
              <button style={styles.chipGhost} onClick={() => setTab("more")}>
                管理…
              </button>
            </div>
          </div>

          {/* Grid */}
          <div style={styles.gridWrap}>
            {gridRows.map((row, r) => {
              // hour rail labels for this 2-hour chunk
              const rowStartSlot = row[0]; // 2-hour start
              const leftHour = slotToTime(rowStartSlot);
              const rightHour = slotToTime(rowStartSlot + 4);

              // segments within this row (8 columns)
              const segments: { startCol: number; len: number; eventId: string }[] = [];
              for (let c = 0; c < 8; c++) {
                const slotIdx = row[c];
                const eid = day.slots[slotIdx];
                if (!eid) continue;

                const prevEid = c > 0 ? day.slots[row[c - 1]] : null;
                if (prevEid === eid) continue;

                let j = c;
                while (j < 8 && day.slots[row[j]] === eid) j++;
                segments.push({ startCol: c, len: j - c, eventId: eid });
              }

              return (
                <div key={r} style={styles.rowWrap}>
                  {/* Hour rail (never covered) */}
                  <div style={styles.hourRail} data-noclear="true">
                    <div style={styles.hourTick}>{leftHour}</div>
                    <div style={styles.hourTickRight}>{rightHour}</div>
                  </div>

                  {/* Grid row */}
                  <div style={styles.gridRow}>
                    {row.map((slotIdx) => {
                      const isSel = selected.has(slotIdx);
                      return (
                        <div
                          key={slotIdx}
                          data-slot={slotIdx}
                          onPointerDown={(e) => onCellPointerDown(e, slotIdx)}
                          onClick={() => onCellTapToggle(slotIdx)}
                          style={{
                            ...styles.cell,
                            background: isSel ? theme.blue : theme.panel,
                            borderColor: isSel ? theme.blueLine : theme.hairline,
                          }}
                        />
                      );
                    })}

                    {/* Segment blocks overlay */}
                    <div style={styles.rowOverlay}>
                      {segments.map((seg, idx) => {
                        const { label, seed } = getEventLabelAndSeed(seg.eventId);
                        const minutes = seg.len * SLOT_MINUTES;

                        const leftPct = (seg.startCol / 8) * 100;
                        const widthPct = (seg.len / 8) * 100;

                        const fill = segmentFillColor(seed, isDark);
                        const accent = segmentAccentColor(seed, isDark);

                        return (
                          <div
                            key={idx}
                            style={{
                              ...styles.segBlock,
                              left: `calc(${leftPct}% + 6px)`,
                              width: `calc(${widthPct}% - 12px)`,
                              background: fill,
                            }}
                          >
                            <div style={{ ...styles.segDot, background: accent }} />
                            <div style={styles.segBlockText}>
                              {label}
                              <span style={styles.segBlockMeta}> · {minutes}m</span>
                            </div>
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

          {/* Spacer so bottom sheet won't cover last rows */}
          <div style={{ height: 110 }} />

          {/* Bottom action sheet (iOS-like) */}
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
              onPickCategoryOnly={async (categoryId) => {
                const evtId = getOrCreateCategoryOnlyEvent(categoryId);
                await applyEvent(evtId);
                setShowPicker(false);
              }}
              isDark={isDark}
            />
          )}
        </div>
      )}

      {tab === "stats" && (
        <div style={styles.page}>
          <h2 style={styles.h2}>统计</h2>

          <div style={styles.card}>
            <div style={styles.cardTitle}>本日（{dateKey}）</div>

            <div style={styles.statsGrid}>
              <div>
                <DonutChart items={donutItems} size={220} isDark={isDark} />
                <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
                  {donutItems.slice(0, 6).map((it) => (
                    <div key={it.label} style={{ display: "grid", gridTemplateColumns: "14px 1fr 70px", gap: 8, alignItems: "center" }}>
                      <div style={{ width: 12, height: 12, borderRadius: 4, background: it.color }} />
                      <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: theme.text }}>
                        {it.label}
                      </div>
                      <div style={{ fontSize: 13, textAlign: "right", color: theme.text, fontWeight: 900 }}>
                        {Math.floor(it.value / 60)}h {it.value % 60}m
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                {dayStats.length === 0 ? (
                  <div style={styles.subtle}>今天还没有标注。</div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {dayStats.map((r) => (
                      <div key={r.eventId} style={styles.statRow}>
                        <div style={styles.statLabel}>{r.label}</div>
                        <div style={styles.statValue}>
                          {Math.floor(r.minutes / 60)}h {r.minutes % 60}m
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
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
                value={settings.themeMode}
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
                  value={settings.nightStart}
                  onChange={(e) => setSettings((s) => (s ? { ...s, nightStart: e.target.value } : s))}
                  style={styles.time}
                />
              </label>

              <label style={styles.inlineLabel}>
                止：
                <input
                  type="time"
                  value={settings.nightEnd}
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
                      <div style={{ fontWeight: 900, color: theme.text }}>{c.name}</div>
                      <button style={styles.secondaryBtn} onClick={() => deleteCategory(c.id)}>
                        删除一级
                      </button>
                    </div>

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
                      {evs.map((ev) => {
                        const label = formatEventLabel(ev, c.name);
                        return (
                          <div key={ev.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                            <button
                              style={{
                                ...styles.chip,
                                background: theme.chipBg,
                                border: `1px solid ${theme.chipBorder}`,
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
                              <span style={{ ...styles.dot, background: segmentAccentColor(label || ev.id, isDark) }} />
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
    <div style={{ ...headerStyles.header, background: theme.headerBg, borderBottom: `1px solid ${theme.hairline}` }}>
      <div style={headerStyles.left}>
        <div style={{ ...headerStyles.brand, color: theme.text }}>DayGrid</div>

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

      <div style={{ ...headerStyles.tabsWrap, background: isDark ? "rgba(255,255,255,0.06)" : "rgba(17,24,39,0.05)", border: `1px solid ${theme.hairline}` }}>
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
  onAdd: (categoryId: string, name?: string) => void;
  styles: Record<string, React.CSSProperties>;
}) {
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!categoryId && categories[0]?.id) setCategoryId(categories[0].id);
  }, [categories, categoryId]);

  return (
    <div style={styles.miniCard}>
      <div style={styles.miniTitle}>新增二级（可空）</div>
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
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：PPT（可留空）" style={styles.input} />
        <button
          style={styles.primaryBtn}
          onClick={() => {
            if (!categoryId) return;
            onAdd(categoryId, name);
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

  // ✅ 关键：确保每个 tab 都是全屏布局，不会被“居中裁切”
  minHeight: "100dvh",
  height: "100dvh",
  width: "100vw",
  maxWidth: "100vw",

  // ✅ 允许纵向滚动；禁用横向溢出，避免右侧被裁
  overflowY: "auto",
  overflowX: "hidden",

  // ✅ 去掉外层 padding，避免 iPhone 模拟时右侧/顶部“挤掉”
  padding: 0,
  margin: 0,

  // ✅ iOS/Android 滚动更像原生
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

    quickRow: { display: "flex", gap: 10, alignItems: "center", marginTop: 10 },

    chipsScroll: { display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6 },

    dot: { width: 10, height: 10, borderRadius: 999, display: "inline-block", marginRight: 8 },

    chip: {
      padding: "9px 11px",
      borderRadius: 999,
      cursor: "pointer",
      whiteSpace: "nowrap",
      fontWeight: 900,
      display: "inline-flex",
      alignItems: "center",
      color: theme.text,
    },

    chipGhost: {
      padding: "9px 11px",
      borderRadius: 999,
      cursor: "pointer",
      whiteSpace: "nowrap",
      fontWeight: 950,
      border: `1px dashed ${theme.hairline}`,
      background: theme.panel,
      color: theme.text,
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
      touchAction: "none",
    },

    rowOverlay: {
      position: "absolute" as const,
      inset: 0,
      pointerEvents: "none" as const,
      zIndex: 2,
    },

    segBlock: {
      position: "absolute" as const,
     top: 6,
      bottom: 6,
     borderRadius: 14,
      overflow: "hidden",
      display: "flex",
      alignItems: "center",
      padding: "8px 10px",
      gap: 8,
      boxShadow: isDark ? "0 10px 22px rgba(0,0,0,0.38)" : "0 10px 16px rgba(0,0,0,0.056)",
      border: `1px solid ${isDark ? "rgba(255,255,255,0.10)" : "rgba(17,24,39,0.10)"}`,
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

    // iOS-like bottom sheet
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
    padding: "12px 12px",
    margin: "0 0 12px 0",
    width: "100%",
    boxSizing: "border-box",
    backdropFilter: "blur(14px)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
  },
  left: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" },
  brand: { fontWeight: 1000, fontSize: 18, letterSpacing: -0.4 },
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
  },
  segBtn: {
    height: 34,
    padding: "0 14px",
    borderRadius: 999,
    cursor: "pointer",
    fontWeight: 950,
  },
};
