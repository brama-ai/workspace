#!/usr/bin/env node
import { jsx as _jsx } from "react/jsx-runtime";
import { render } from "ink";
import { App } from "./components/App.js";
const tasksRoot = process.argv[2] || "";
render(_jsx(App, { tasksRoot: tasksRoot }));
