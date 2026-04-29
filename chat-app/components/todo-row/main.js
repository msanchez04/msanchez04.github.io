export default async () => ({
  name: "TodoRow",
  props: {
    model: {
      type: Object,
      required: true,
    },
  },
  emits: ["patch", "remove"],
  template: await fetch(new URL("./index.html", import.meta.url)).then((r) =>
    r.text(),
  ),
});
