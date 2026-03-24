#!/usr/bin/env node
import { render } from "ink";
import { App } from "./components/App.js";

const tasksRoot = process.argv[2] || "";
render(<App tasksRoot={tasksRoot} />);
