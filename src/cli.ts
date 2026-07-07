#!/usr/bin/env node
import { buildProgram } from "./program.js";

buildProgram()
  .parseAsync()
  .catch((err: Error) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
