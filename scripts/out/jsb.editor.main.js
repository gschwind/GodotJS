"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run_npm_install = exports.auto_complete = void 0;
// entry point (editor only)
const godot_1 = require("godot");
function auto_complete(pattern) {
    let results = new godot_1.PackedStringArray();
    if (typeof pattern !== "string") {
        return results;
    }
    let scope = null;
    let head = '';
    let index = pattern.lastIndexOf('.');
    let left = '';
    if (index >= 0) {
        left = pattern.substring(0, index + 1);
        try {
            scope = eval(pattern.substring(0, index));
        }
        catch (e) {
            return results;
        }
        pattern = pattern.substring(index + 1);
    }
    else {
        scope = globalThis;
    }
    for (let k in scope) {
        if (k.indexOf(pattern) == 0) {
            results.append(head + left + k);
        }
    }
    return results;
}
exports.auto_complete = auto_complete;
function run_npm_install() {
    if (godot_1.OS.get_name() != "Windows") {
        //TODO untested on other platforms, just output a warning for now.
        console.warn("package.json has been copied to the project, please run `npm install` manually in the project's root path.");
        return;
    }
    let pid = godot_1.OS.create_process("npm.cmd", ["install"], true);
    if (pid == -1) {
        console.error("Failed to execute `npm install`, please ensure that node.js has been installed properly, and run it manually in the project root path.");
    }
    else {
        console.log("Started process: npm install");
    }
}
exports.run_npm_install = run_npm_install;
//# sourceMappingURL=jsb.editor.main.js.map