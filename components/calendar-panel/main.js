import { computed, ref } from "vue";

export default async () => ({
  name: "CalendarPanel",
  template: await fetch(new URL("./index.html", import.meta.url)).then((r) =>
    r.text(),
  ),
  props: {
    events: { type: Array, default: () => [] },
  },
  emits: ["addEvent", "patchEvent", "removeEvent"],
  setup(props, { emit }) {
    const today = new Date();
    const activeMonth = ref(new Date(today.getFullYear(), today.getMonth(), 1));
    const selectedDate = ref(formatDateKey(today));
    const newEventTitle = ref("");
    const newEventDate = ref("");

    const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const monthOptions = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const yearOptions = computed(() => {
      const current = today.getFullYear();
      const out = [];
      for (let y = current - 5; y <= current + 5; y++) out.push(y);
      return out;
    });

    const monthTitle = computed(() =>
      activeMonth.value.toLocaleString(undefined, {
        month: "long",
        year: "numeric",
      }),
    );

    const eventsByDate = computed(() => {
      const map = new Map();
      for (let i = 0; i < props.events.length; i++) {
        const ev = props.events[i];
        const due = String(ev?.due ?? "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) continue;
        if (!map.has(due)) map.set(due, []);
        map.get(due).push({ ...ev, index: i });
      }
      return map;
    });

    const calendarCells = computed(() => {
      const y = activeMonth.value.getFullYear();
      const m = activeMonth.value.getMonth();
      const firstWeekday = new Date(y, m, 1).getDay();
      const gridStart = new Date(y, m, 1 - firstWeekday);
      const cells = [];
      const cursor = new Date(gridStart);
      const todayKey = formatDateKey(today);
      for (let i = 0; i < 42; i++) {
        const key = formatDateKey(cursor);
        const inMonth = cursor.getMonth() === m;
        cells.push({
          key,
          day: cursor.getDate(),
          inMonth,
          isToday: key === todayKey,
          isSelected: key === selectedDate.value,
          events: eventsByDate.value.get(key) || [],
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      return cells;
    });

    const selectedEvents = computed(
      () => eventsByDate.value.get(selectedDate.value) || [],
    );

    const selectedDateLabel = computed(() =>
      formatDateLong(selectedDate.value),
    );

    function prevMonth() {
      const d = activeMonth.value;
      activeMonth.value = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    }

    function nextMonth() {
      const d = activeMonth.value;
      activeMonth.value = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }

    function goToToday() {
      const t = new Date();
      activeMonth.value = new Date(t.getFullYear(), t.getMonth(), 1);
      selectedDate.value = formatDateKey(t);
    }

    function setMonthFromSelect(value) {
      const nextMonth = Number.parseInt(String(value), 10);
      if (!Number.isFinite(nextMonth) || nextMonth < 0 || nextMonth > 11) return;
      const d = activeMonth.value;
      activeMonth.value = new Date(d.getFullYear(), nextMonth, 1);
    }

    function setYearFromSelect(value) {
      const nextYear = Number.parseInt(String(value), 10);
      if (!Number.isFinite(nextYear) || nextYear < 1000 || nextYear > 9999) return;
      const d = activeMonth.value;
      activeMonth.value = new Date(nextYear, d.getMonth(), 1);
    }

    function selectDate(dateKey) {
      selectedDate.value = dateKey;
      if (!newEventDate.value) newEventDate.value = dateKey;
    }

    function addEvent() {
      const title = newEventTitle.value.trim();
      const due = newEventDate.value;
      if (!title || !due) {
        window.alert("Add both a title and date for calendar events.");
        return;
      }
      // Parent app stores and sorts events.
      emit("addEvent", { title, due });
      newEventTitle.value = "";
      newEventDate.value = "";
    }

    function formatDate(value) {
      if (!value) return "";
      return new Date(`${value}T00:00:00`).toLocaleDateString();
    }

    /** Short label for month grid cells (full text in tooltip via title). */
    function previewTitle(raw) {
      const t = String(raw ?? "").trim() || "Untitled";
      const max = 22;
      if (t.length <= max) return t;
      return `${t.slice(0, max - 1)}…`;
    }

    function dayCellAriaLabel(cell) {
      const bits = [String(cell.day)];
      if (cell.isToday) bits.push("today");
      if (!cell.inMonth) bits.push("outside this month");
      if (cell.events.length) {
        const titles = cell.events.map((e) => {
          const t = String(e?.title ?? "").trim();
          return t || "Untitled";
        });
        bits.push(`${titles.length} event${titles.length > 1 ? "s" : ""}: ${titles.join("; ")}`);
      }
      return bits.join(", ");
    }

    return {
      weekdayLabels,
      monthOptions,
      yearOptions,
      monthTitle,
      activeMonth,
      calendarCells,
      selectedDateLabel,
      selectedEvents,
      newEventTitle,
      newEventDate,
      addEvent,
      formatDate,
      previewTitle,
      dayCellAriaLabel,
      prevMonth,
      nextMonth,
      goToToday,
      setMonthFromSelect,
      setYearFromSelect,
      selectDate,
    };
  },
});

function formatDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateLong(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) return "";
  const d = new Date(`${key}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
