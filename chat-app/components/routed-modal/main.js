export default async () => ({
  name: "RoutedModalShell",
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, required: true },
    titleId: { type: String, required: true },
    panelClass: { type: String, default: "" },
  },
  emits: ["close"],
  template: await fetch(new URL("./index.html", import.meta.url)).then((r) =>
    r.text(),
  ),
});
