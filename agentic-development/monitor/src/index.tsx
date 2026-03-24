#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./components/App.js";

const tasksRoot = process.argv[2] || "";

render(<App tasksRoot={tasksRoot} />);
