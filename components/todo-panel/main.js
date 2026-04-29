export default async () => {
  const template = await fetch(new URL("./index.html", import.meta.url)).then(
    (r) => r.text(),
  );
  const todoRowFactory = (await import("../todo-row/main.js")).default;
  const TodoRow = await todoRowFactory();
  return {
    name: "TodoPanel",
    components: { TodoRow },
    props: {
      items: { type: Array, default: () => [] },
    },
    emits: ["add", "remove", "patchTodo"],
    template,
  };
};
