import { computed } from "vue";

function calendarMatrix(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const gridStart = new Date(y, m, 1 - firstWeekday);
  const weeks = [];
  const cursor = new Date(gridStart);
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let i = 0; i < 7; i++) {
      const inMonth = cursor.getMonth() === m;
      const isToday =
        cursor.getFullYear() === now.getFullYear() &&
        cursor.getMonth() === now.getMonth() &&
        cursor.getDate() === now.getDate();
      row.push({
        day: cursor.getDate(),
        outside: !inMonth,
        today: isToday,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

export default async () => ({
  name: "CalendarPanel",
  template: await fetch(new URL("./index.html", import.meta.url)).then((r) =>
    r.text(),
  ),
  setup() {
    const calendarWeekdayLabels = [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat",
    ];
    const calendarMonthLabel = computed(() =>
      new Date().toLocaleString(undefined, { month: "long", year: "numeric" }),
    );
    const calendarWeeks = computed(() => calendarMatrix(new Date()));
    return {
      calendarWeekdayLabels,
      calendarMonthLabel,
      calendarWeeks,
    };
  },
});
