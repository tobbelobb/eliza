import { Plugin } from "@ai16z/eliza";
import { ragciteAction } from "./actions/ragcite.ts";

export const ragcitePlugin: Plugin = {
    name: "ragcite",
    description: "Let agent cite directly from its knowledge base when appropriate",
    actions: [ragciteAction],
    evaluators: [],
    providers: [],
};

export default ragcitePlugin;
