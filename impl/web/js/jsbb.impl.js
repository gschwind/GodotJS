"use strict";
;
var jsbb_PropertyFlags;
(function (jsbb_PropertyFlags) {
    jsbb_PropertyFlags[jsbb_PropertyFlags["CONFIGURABLE"] = 1] = "CONFIGURABLE";
    jsbb_PropertyFlags[jsbb_PropertyFlags["WRITABLE"] = 2] = "WRITABLE";
    jsbb_PropertyFlags[jsbb_PropertyFlags["ENUMERABLE"] = 4] = "ENUMERABLE";
    jsbb_PropertyFlags[jsbb_PropertyFlags["GET"] = 8] = "GET";
    jsbb_PropertyFlags[jsbb_PropertyFlags["SET"] = 16] = "SET";
    jsbb_PropertyFlags[jsbb_PropertyFlags["VALUE"] = 32] = "VALUE";
})(jsbb_PropertyFlags || (jsbb_PropertyFlags = {}));
// a recommended stack size cap (not a limitation)
const jsbb_kMaxStackSize = 512;
const jsbb_StackPos = {
    Undefined: 0,
    Null: 1,
    True: 2,
    False: 3,
    EmptyString: 4,
    SymbolClass: 5,
    MapClass: 6,
    Error: 7,
    _Num: 8,
};
const jsbb_PropertyFilter = {
    SKIP_STRINGS: 8,
    SKIP_SYMBOLS: 16
};
function jsbb_IsTraceable(o) {
    const type = typeof o;
    return !(o !== null && type !== "function" && type !== "object");
}
function jsbb_ensure(condition) {
    console.assert(condition);
}
const jsbb_console = {
    log: function (...args) {
        console.log("[jsbb]", ...args);
    },
    warn: function (...args) {
        console.warn("[jsbb]", ...args);
    },
    error: function (...args) {
        console.error("[jsbb]", ...args);
    },
    trace: function (...args) {
        console.trace("[jsbb]", ...args);
    }
};
// opaque for UniversalBridgeClass
const jsbb_opaque = Symbol();
const jsbb_internal_field_count = Symbol();
//TODO fastpath to verify a UniversalBridgeClass
// const jsbb_hidden = Symbol();
// Stack for Locals (starts from zero)
class jsbb_Stack {
    constructor() {
        this.frames = [];
        this.values = [];
        this._depth = 0;
    }
    /** stack used */
    get pos() { return this.values.length; }
    /** depth of scope entered */
    get depth() { return this._depth; }
    SetValue(pos, value) {
        if (pos < 0 || pos >= this.values.length) {
            throw new RangeError("invalid stack position");
        }
        this.values[pos] = value;
    }
    // get frame value
    GetValue(pos) {
        if (pos < 0 || pos >= this.values.length) {
            throw new RangeError("invalid stack position");
        }
        return this.values[pos];
    }
    // return stack offset
    Push(val) {
        if (this.values.length >= jsbb_kMaxStackSize) {
            jsbb_console.warn("stack overflow", this.values.length);
        }
        return this.values.push(val) - 1;
    }
    EnterScope() {
        ++this._depth;
        this.frames.push(this.values.length);
    }
    ExitScope() {
        --this._depth;
        const frame = this.frames.pop();
        this.values.length = frame;
    }
}
// a wrapper for primitive types (number, string etc.)
class jsbb_Wrapper {
    constructor(target) {
        this.target = target;
    }
}
class jsbb_Handles {
    get count() { return this._count; }
    constructor() {
        this._idgen = 0;
        this._count = 0;
        this._handles = [];
        this._handles[999] = undefined;
    }
    // trace an object (it's strongly referenced by default)
    AddValue(o) {
        if (!jsbb_IsTraceable(o)) {
            o = new jsbb_Wrapper(o);
        }
        const token = new WeakRef(o);
        const id = this._idgen++;
        this._handles[id] = {
            token: token,
            sref: o,
        };
        ++this._count;
        return id;
    }
    IsValid(handle_id) {
        const handle = this._handles[handle_id];
        if (typeof handle === "undefined") {
            return false;
        }
        if (handle.sref != undefined || handle.token.deref() != undefined) {
            return true;
        }
        //TODO gc finalizer is run after the object dead, it's impossible to get a valid internal_data in gc_callback
        jsbb_console.warn("obsolete handle", handle_id);
        delete this._handles[handle_id];
        --this._count;
        return false;
    }
    // unsafe, must ensure a valid index by yourself
    Remove(handle_id) {
        if (typeof this._handles[handle_id] === "undefined") {
            return;
        }
        delete this._handles[handle_id];
        --this._count;
    }
    // return the original target object in registry
    GetValue(handle_id) {
        const handle = this._handles[handle_id];
        if (typeof handle === "undefined") {
            jsbb_console.warn("invalid handle id", handle_id);
            return;
        }
        const target = handle.token.deref();
        if (target instanceof jsbb_Wrapper) {
            return target.target;
        }
        return target;
    }
    SetWeak(handle_id) {
        const handle = this._handles[handle_id];
        if (typeof handle === "undefined") {
            jsbb_console.warn("invalid handle id", handle_id);
            return;
        }
        handle.sref = undefined;
    }
    SetStrong(handle_id) {
        const handle = this._handles[handle_id];
        if (typeof handle === "undefined") {
            jsbb_console.warn("invalid handle id", handle_id);
            return;
        }
        handle.sref = handle.token.deref();
    }
}
class jsbb_Registry {
    get count() { return this._count; }
    constructor(engine_opaque) {
        this._count = 0;
        const self = this;
        this.engine_opaque = engine_opaque;
        this.watcher = new FinalizationRegistry(function (internal_data) {
            jsbb_console.log("gc.dealloc", internal_data);
            --self._count;
            _jsbb_.interop.gc_callback(self.engine_opaque, internal_data);
        });
    }
    Add(obj, internal_data) {
        jsbb_console.log("gc.alloc", internal_data);
        // opaque saved in obj[opaque.symbol] for GetOpaque(), it's never changed.
        obj[jsbb_opaque] = internal_data;
        this.watcher.register(obj, internal_data);
        ++this._count;
    }
}
class jsbb_External {
    get data() { return this._data; }
    constructor(data) {
        this._data = data;
    }
}
class jsbb_Engine {
    get stack() { return this._stack; }
    get handles() { return this._handles; }
    /** If calling from C++ side, use `_throw(err)` to raise an error instead of `throw`. */
    _throw(value) {
        const last = this._stack.GetValue(jsbb_StackPos.Error);
        if (last !== undefined) {
            jsbb_console.error("discarding an unhandled error:", last);
        }
        if (value !== undefined) {
            jsbb_console.error("throwing an error in native execution context:", typeof value, value);
        }
        this._stack.SetValue(jsbb_StackPos.Error, value);
    }
    constructor(engine_id, opaque) {
        this._opaque = 0;
        jsbb_console.log("new engine", engine_id, opaque);
        this._id = engine_id;
        this._opaque = opaque;
        // this._global = {};
        this._stack = new jsbb_Stack();
        this._handles = new jsbb_Handles();
        this._registry = new jsbb_Registry(opaque);
        // init all commonly used string here
        this._atoms = new Array(2);
        this._atoms[0] = "message";
        this._atoms[1] = "stack";
        // init fixed stack objects
        jsbb_ensure(this._stack.Push(undefined) === jsbb_StackPos.Undefined);
        jsbb_ensure(this._stack.Push(null) === jsbb_StackPos.Null);
        jsbb_ensure(this._stack.Push(true) === jsbb_StackPos.True);
        jsbb_ensure(this._stack.Push(false) === jsbb_StackPos.False);
        jsbb_ensure(this._stack.Push("") === jsbb_StackPos.EmptyString);
        jsbb_ensure(this._stack.Push(Symbol) === jsbb_StackPos.SymbolClass);
        jsbb_ensure(this._stack.Push(Map) === jsbb_StackPos.MapClass);
        jsbb_ensure(this._stack.Push(undefined) === jsbb_StackPos.Error);
        jsbb_ensure(this._stack.pos === jsbb_StackPos._Num);
    }
    GetStatistics(data_ptr) {
        if (data_ptr === 0)
            return;
        const offset = data_ptr >> 2;
        _jsbb_.i32[offset + 0] = this._stack.pos;
        _jsbb_.i32[offset + 1] = this._handles.count;
        _jsbb_.i32[offset + 2] = this._registry.count;
    }
    Release() {
        // this._global = <any>undefined;
        this._handles = undefined;
        this._stack = undefined;
        this._registry = undefined;
    }
    SetHostPromiseRejectionTracker(cb, data) {
        const self = this;
        window.addEventListener("unhandledrejection", function (ev) {
            jsbb_console.warn("unhandled_rejection", ev.promise, ev.reason);
            self._stack.EnterScope();
            try {
                _jsbb_.interop.unhandled_rejection(self._opaque, cb, self._stack.Push(ev.promise), self._stack.Push(ev.reason));
            }
            catch (err) {
                // rejection handler must do not throw error
                jsbb_console.error("unexpected error", err);
            }
            self._stack.ExitScope();
        });
    }
    static GetStringHash(val) {
        let hash = 0;
        const len = val.length;
        for (let i = 0; i < len; ++i) {
            hash = (hash << 5) - hash + val.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }
    static GetNumberHash(val) {
        if ((val | 0) != 0)
            return val;
        return jsbb_Engine.GetStringHash(val.toString());
    }
    // must return a stable hash for value.
    // 0 is OK but introduce additional strict_eq evaluation.
    GetIdentityHash(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        if (typeof val === "undefined" || val === null)
            return 0;
        if (typeof val === "number")
            return jsbb_Engine.GetNumberHash(val);
        if (typeof val === "boolean")
            return val ? 1 : 0;
        if (typeof val === "string")
            return jsbb_Engine.GetStringHash(val);
        if (typeof val === "bigint")
            return jsbb_Engine.GetStringHash(val.toString());
        // if (typeof val === "function")
        // if (typeof val === "object")
        // if (typeof val === "symbol") 
        // internal data index as hash since it's never changed
        if (typeof val[jsbb_opaque] !== "undefined")
            return val[jsbb_opaque] | 0;
        return 0;
    }
    GetByteLength(buf_sp) {
        const buf = this._stack.GetValue(buf_sp);
        if (buf instanceof ArrayBuffer) {
            return buf.byteLength;
        }
        return 0;
    }
    /** copy the data of a buffer at stack_pos into HEAP at `data_dst`  */
    ReadArrayBufferData(stack_pos, size, data_dst) {
        const val = this._stack.GetValue(stack_pos);
        if (val instanceof ArrayBuffer) {
            if (val.byteLength < size) {
                jsbb_console.error("ArrayBuffer: not enough data to read");
                return -1;
            }
            _jsbb_.u8.set(new Uint8Array(val), data_dst);
            return 1;
        }
        jsbb_console.error("ReadArrayBufferData: not an ArrayBuffer");
        return -1;
    }
    NewArrayBuffer(data_src, size) {
        // make a copy of the memory from data_src with size
        const data = new Uint8Array(_jsbb_.u8.buffer, data_src, size).slice();
        return this._stack.Push(data.buffer);
    }
    GetExternal(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        if (val instanceof jsbb_External) {
            return val.data;
        }
        return 0;
    }
    GetStringLength(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        if (typeof val === "string") {
            return val.length;
        }
        return 0;
    }
    GetArrayLength(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        if (val instanceof Array) {
            return val.length;
        }
        return 0;
    }
    /**
     * get a native copy of a javascript string (convert if not a string) .
     * @param o_size [output] size of the returned buffer
     * @returns pointer the the buffer (HEAP)
     */
    ToCStringLen(o_size, str_sp) {
        const val = this._stack.GetValue(str_sp);
        const str = String(val);
        const len = _jsbb_.wasmop.lengthBytesUTF8(str);
        _jsbb_.i32[o_size >> 2] = len;
        if (len <= 0) {
            if (typeof val !== "string" || val.length !== 0) {
                jsbb_console.warn("alloc.CString (failed)", len, typeof val);
            }
            return 0;
        }
        const size = len + 1;
        const buf = _jsbb_.wasmop._malloc(size);
        _jsbb_.wasmop.stringToUTF8(str, buf, size);
        // jsbb_console.log("alloc.CString", str, buf, size);
        return buf;
    }
    /** push the given value as string on the stack */
    ToString(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        return this._stack.Push(String(val));
    }
    NumberValue(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        return Number(val);
    }
    BooleanValue(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        return Boolean(val);
    }
    Int32Value(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        return Number(val) | 0;
    }
    Uint32Value(stack_pos) {
        const val = this._stack.GetValue(stack_pos);
        return (Number(val) | 0) >>> 0;
    }
    Int64Value(stack_pos, o_value_ptr) {
        const val = this._stack.GetValue(stack_pos);
        _jsbb_.i64[o_value_ptr >> 3] = val;
        return true;
    }
    /** duplicate a value to the stack top */
    StackDup(stack_pos) {
        return this._stack.Push(this._stack.GetValue(stack_pos));
    }
    StackSet(to_sp, from_sp) {
        this._stack.SetValue(to_sp, this._stack.GetValue(from_sp));
    }
    StackSetInt32(to_sp, value) {
        this._stack.SetValue(to_sp, value);
    }
    HasError() {
        return this._stack.GetValue(jsbb_StackPos.Error) !== undefined;
    }
    /** throw an error with a message in native execution context */
    ThrowError(message_ptr) {
        let message = _jsbb_.wasmop.UTF8ToString(message_ptr);
        this._throw(new Error(message));
    }
    GetOpaque(stack_pos) {
        let obj = this._stack.GetValue(stack_pos);
        if (typeof obj !== "object") {
            return 0;
        }
        const opaque = obj[jsbb_opaque];
        return typeof opaque === "number" ? opaque : 0;
    }
    NewString(cstr_ptr, len) {
        if (len === 0) {
            return this._stack.Push("");
        }
        let str = _jsbb_.wasmop.UTF8ToString(cstr_ptr);
        if (typeof str !== "string") {
            jsbb_console.error("invalid string", cstr_ptr, len);
        }
        return this._stack.Push(str);
    }
    NewExternal(data) {
        return this._stack.Push(new jsbb_External(data));
    }
    NewInt32(value) {
        return this._stack.Push(value);
    }
    /** treated as an integer, uint32 is not really fully supported */
    NewUint32(value) {
        return this._stack.Push(value >>> 0);
    }
    NewNumber(value) {
        return this._stack.Push(value);
    }
    NewBigInt64(val_ptr) {
        const val = _jsbb_.i64[val_ptr >> 3];
        return this._stack.Push(val);
    }
    NewSymbol() {
        return this._stack.Push(Symbol());
    }
    NewMap() {
        return this._stack.Push(new Map());
    }
    NewArray() {
        return this._stack.Push([]);
    }
    IsExternal(stack_pos) {
        return this._stack.GetValue(stack_pos) instanceof jsbb_External;
    }
    DefineProperty(obj_sp, key_sp, value_sp, get_sp, set_sp, flags) {
        try {
            const obj = this._stack.GetValue(obj_sp);
            const key = this._stack.GetValue(key_sp);
            if ((flags & jsbb_PropertyFlags.VALUE) !== 0) {
                // with value
                // jsbb_console.log("define property value", obj, key, flags, value_sp);
                if ((flags & jsbb_PropertyFlags.GET) !== 0 || (flags & jsbb_PropertyFlags.SET) !== 0) {
                    jsbb_console.warn("do not define a property with value and get/set at the same time");
                }
                Object.defineProperty(obj, key, {
                    configurable: (flags & jsbb_PropertyFlags.CONFIGURABLE) !== 0,
                    enumerable: (flags & jsbb_PropertyFlags.ENUMERABLE) !== 0,
                    writable: (flags & jsbb_PropertyFlags.WRITABLE) !== 0,
                    value: this._stack.GetValue(value_sp)
                });
            }
            else {
                // with get/set
                // jsbb_console.log("define property getset", obj, key, flags, get_sp, set_sp);
                if ((flags & jsbb_PropertyFlags.WRITABLE) !== 0) {
                    jsbb_console.warn("can not define a getset property with writable flag");
                }
                if (this._stack.GetValue(get_sp) === undefined && this._stack.GetValue(set_sp) === undefined) {
                    jsbb_console.warn("can not define a getset property with getter and setter not defined both");
                }
                Object.defineProperty(obj, key, {
                    configurable: (flags & jsbb_PropertyFlags.CONFIGURABLE) !== 0,
                    enumerable: (flags & jsbb_PropertyFlags.ENUMERABLE) !== 0,
                    get: (flags & jsbb_PropertyFlags.GET) !== 0 ? this._stack.GetValue(get_sp) : undefined,
                    set: (flags & jsbb_PropertyFlags.SET) !== 0 ? this._stack.GetValue(set_sp) : undefined
                });
            }
            return 1;
        }
        catch (err) {
            this._throw(err);
            return -1;
        }
    }
    DefineLazyProperty(obj_sp, key_sp, cb) {
        const obj = this._stack.GetValue(obj_sp);
        const key = this._stack.GetValue(key_sp);
        const self = this;
        Object.defineProperty(obj, key, {
            get: function () {
                self._stack.EnterScope();
                // prepare: fixed initial call stack positions
                const rval_sp = self._stack.Push(undefined); // 0 return value (placeholder)
                const key_sp = self._stack.Push(key);
                try {
                    _jsbb_.interop.call_accessor(self._opaque, cb, key_sp, rval_sp);
                    self.rethrow_native_error();
                }
                catch (err) {
                    jsbb_console.error("DefineLazyProperty: unexpected error", err);
                    // cleanup 
                    self._stack.ExitScope();
                    // in javascript execution context
                    throw err;
                }
                const rval = self._stack.GetValue(rval_sp);
                // cleanup
                self._stack.ExitScope();
                jsbb_console.log("evaluated lazy property", key, rval);
                // overwrite 
                Object.defineProperty(this, key, {
                    value: rval,
                    configurable: true,
                    enumerable: true,
                    writable: true
                });
                return rval;
            },
            configurable: true,
            enumerable: true
        });
        return 1;
    }
    SetProperty(obj_sp, key_sp, val_sp) {
        try {
            const obj = this._stack.GetValue(obj_sp);
            const key = this._stack.GetValue(key_sp);
            const val = this._stack.GetValue(val_sp);
            if (obj instanceof Map) {
                obj.set(key, val);
            }
            else {
                obj[key] = val;
            }
            return 1;
        }
        catch (err) {
            this._throw(err);
            return -1;
        }
    }
    //
    SetPropertyUint32(obj_sp, index, value_sp) {
        try {
            const obj = this._stack.GetValue(obj_sp);
            const val = this._stack.GetValue(value_sp);
            obj[index] = val;
            return 1;
        }
        catch (err) {
            this._throw(err);
            return -1;
        }
    }
    //TODO filter and key_conversion are not implemented (or not supported?)
    GetOwnPropertyNames(obj_sp, filter, key_conversion) {
        try {
            const obj = this._stack.GetValue(obj_sp);
            const names = Object.getOwnPropertyNames(obj);
            if (names instanceof Array) {
                return this._stack.Push(names);
            }
            this._throw(new TypeError("GetOwnPropertyDescriptor: unexpected"));
            return jsbb_StackPos.Error;
        }
        catch (err) {
            this._throw(err);
            return jsbb_StackPos.Error;
        }
    }
    GetOwnPropertyDescriptor(obj_sp, key_sp) {
        try {
            const key = this._stack.GetValue(key_sp);
            const obj = this._stack.GetValue(obj_sp);
            const desc = Object.getOwnPropertyDescriptor(obj, key);
            if (typeof desc === "object") {
                return this._stack.Push(desc);
            }
            this._throw(new TypeError("GetOwnPropertyDescriptor: unexpected"));
            return jsbb_StackPos.Error;
        }
        catch (err) {
            this._throw(err);
            return jsbb_StackPos.Error;
        }
    }
    /** get property value by atom_id (a cached string) */
    GetPropertyAtomID(obj_sp, atom_id) {
        const obj = this._stack.GetValue(obj_sp);
        const key = this._atoms[atom_id];
        if (typeof key !== "string") {
            this._throw(new Error(`invalid AtomID(${atom_id})`));
            return jsbb_StackPos.Error;
        }
        if (typeof obj !== "object") {
            this._throw(new Error(`invalid object to access property at ${obj_sp} with AtomID ${atom_id}`));
            return jsbb_StackPos.Error;
        }
        const val = obj[key];
        if (typeof val === "undefined") {
            return jsbb_StackPos.Undefined;
        }
        return this._stack.Push(val);
    }
    GetProperty(obj_sp, key_sp) {
        const obj = this._stack.GetValue(obj_sp);
        const key = this._stack.GetValue(key_sp);
        if (typeof key !== "string" && typeof key !== "symbol") {
            this._throw(new Error("invalid atom id"));
            return jsbb_StackPos.Error;
        }
        try {
            const val = obj instanceof Map ? obj.get(key) : obj[key];
            // saving stack space
            if (typeof val === "undefined") {
                return jsbb_StackPos.Undefined;
            }
            return this._stack.Push(val);
        }
        catch (err) {
            this._throw(err);
            return jsbb_StackPos.Error;
        }
    }
    GetPropertyUint32(obj_sp, index) {
        const obj = this._stack.GetValue(obj_sp);
        if (typeof index !== "number") {
            this._throw(new Error("invalid atom id"));
            return jsbb_StackPos.Error;
        }
        try {
            const val = obj[index];
            // saving stack space
            if (typeof val === "undefined") {
                return jsbb_StackPos.Undefined;
            }
            return this._stack.Push(val);
        }
        catch (err) {
            this._throw(err);
            return jsbb_StackPos.Error;
        }
    }
    // push global to stack, return it's stack position
    GetGlobalObject() {
        //TODO temporarily use browser global object
        return this._stack.Push(jsbb_browser);
        // return this._stack.Push(this._global);
    }
    CompileFunctionSource(filename_ptr, source_ptr) {
        let source = _jsbb_.wasmop.UTF8ToString(source_ptr);
        let rval = undefined;
        try {
            if (source == null) {
                this._throw(new Error("source is null"));
                return jsbb_StackPos.Error;
            }
            // jsbb_console.log("compile function source:", source);
            rval = eval(source);
        }
        catch (err) {
            if (err instanceof EvalError && typeof document !== "undefined") {
                jsbb_console.warn("eval not supported (CSP restriction), trying script element instead");
                // module_source must be a bare function source (like '(function(){ ... })')
                try {
                    //TODO if async module is implemented, we can use dynamic scripts which support debugging in browser devtools
                    // but for now, we need a method to eval source synchronously
                    let script = document.createElement("script");
                    script.type = "type/javascript";
                    script.text = `_jsbb_.evalResult = ${source};`;
                    document.head.appendChild(script);
                    rval = _jsbb_.evalResult;
                    _jsbb_.evalResult = undefined;
                    // document.head.removeChild(script);
                }
                catch (err2) {
                    jsbb_console.error("unexpected error", err2);
                    this._throw(err2);
                    return jsbb_StackPos.Error;
                }
            }
            else {
                let filename = _jsbb_.wasmop.UTF8ToString(filename_ptr);
                jsbb_console.error(filename, err);
                this._throw(err);
                return jsbb_StackPos.Error;
            }
        }
        if (typeof rval !== "function") {
            this._throw(new Error("source compiled with no function returned"));
            return jsbb_StackPos.Error;
        }
        // jsbb_console.log("function source is compiled sucessfully");
        return this._stack.Push(rval);
    }
    /**
     * eval source code.
     * not supported if CSP is enabled.
     */
    Eval(filename_ptr, source_ptr) {
        let source = _jsbb_.wasmop.UTF8ToString(source_ptr);
        let rval = undefined;
        try {
            if (source == null) {
                this._throw(new Error("source is null"));
                return jsbb_StackPos.Error;
            }
            rval = eval(source);
        }
        catch (err) {
            // it's difficult to emulate the behaviour of eval with script element (get the result without 'return').
            // just throw error for easier life.
            let filename = _jsbb_.wasmop.UTF8ToString(filename_ptr);
            jsbb_console.error(filename, err);
            this._throw(err);
            return jsbb_StackPos.Error;
        }
        if (typeof rval === "undefined") {
            return jsbb_StackPos.Undefined;
        }
        return this._stack.Push(rval);
    }
    Call(this_sp, func_sp, argc, argv) {
        // jsbb_console.log(`Call this_sp:${this_sp} func_sp:${func_sp}, argc:${argc}, argv:${argv}`);
        const thiz = this._stack.GetValue(this_sp);
        const func = this._stack.GetValue(func_sp);
        if (typeof func !== "function") {
            this._throw(new TypeError("not a function"));
            return jsbb_StackPos.Error;
        }
        try {
            let args = undefined;
            if (argc > 0) {
                args = new Array(argc);
                for (let i = 0; i < argc; ++i) {
                    const arg_sp = _jsbb_.i32[(argv >> 2) + i];
                    args[i] = this._stack.GetValue(arg_sp);
                    // jsbb_console.log(`arg:${i} sp:${arg_sp} arg:${typeof args[i]}`);
                }
            }
            // jsbb_console.log("[Call]", thiz, args);
            const rval = func.apply(thiz, args);
            if (rval === undefined) {
                return jsbb_StackPos.Undefined;
            }
            return this._stack.Push(rval);
        }
        catch (error) {
            this._throw(error);
            return jsbb_StackPos.Error;
        }
    }
    CallAsConstructor(func_sp, argc, argv) {
        // jsbb_console.log("CallAsConstructor", func_sp, argc, argv);
        const func = this._stack.GetValue(func_sp);
        if (typeof func !== "function") {
            this._throw(new TypeError("not a function"));
            return jsbb_StackPos.Error;
        }
        try {
            let args = undefined;
            if (argc > 0) {
                args = new Array(argc);
                for (let i = 0; i < argc; ++i) {
                    const arg_sp = _jsbb_.i32[(argv >> 2) + i];
                    args[i] = this._stack.GetValue(arg_sp);
                }
            }
            const rval = args === undefined ? new func() : new func(...args);
            return this._stack.Push(rval);
        }
        catch (err) {
            this._throw(err);
            return jsbb_StackPos.Error;
        }
    }
    // push `obj.__proto__` to stack
    GetPrototypeOf(obj_sp) {
        try {
            const obj = this._stack.GetValue(obj_sp);
            return this._stack.Push(Object.getPrototypeOf(obj));
        }
        catch (err) {
            this._throw(err);
            return jsbb_StackPos.Error;
        }
    }
    SetPrototypeOf(obj_sp, proto_sp) {
        try {
            const obj = this._stack.GetValue(obj_sp);
            const proto = this._stack.GetValue(proto_sp);
            if (typeof obj !== "object" || typeof proto !== "object") {
                this._throw(new TypeError("invalid object or prototype"));
                return -1;
            }
            Object.setPrototypeOf(obj, proto);
            return 1;
        }
        catch (err) {
            this._throw(err);
            return -1;
        }
    }
    HasOwnProperty(obj_sp, key_sp) {
        try {
            const obj = this._stack.GetValue(obj_sp);
            const key = this._stack.GetValue(key_sp);
            if (!_jsbb_.is_object(obj) || (typeof key !== "string" && typeof key !== "symbol")) {
                this._throw(new TypeError(`invalid object or key: ${key}`));
                return -1;
            }
            return obj.hasOwnProperty(key) ? 1 : 0;
        }
        catch (err) {
            this._throw(err);
            return -1;
        }
    }
    /**
     * Rethrow the last error thrown in native context to javascript execution context.
     * WILL NEVER RETURN IF ERROR THROWN.
     */
    rethrow_native_error() {
        const error = this._stack.GetValue(jsbb_StackPos.Error);
        if (error !== undefined) {
            if (error === null) {
                jsbb_console.warn("rethrowing a null error (usually caused by fatal errors in native code?)");
            }
            this._stack.SetValue(jsbb_StackPos.Error, undefined);
            throw error;
        }
    }
    // [stack-based]
    // cb: C++ Function Pointer
    // return: stack position of the wrapper function 
    NewCFunction(cb, data_pos, func_name_ptr) {
        const self = this;
        const data = this._stack.GetValue(data_pos);
        const func_name = func_name_ptr == 0 ? "(CFunction)" : _jsbb_.wasmop.UTF8ToString(func_name_ptr);
        // jsbb_console.log("NewCFunction", func_name, cb, data);
        return this._stack.Push(function () {
            self._stack.EnterScope();
            // prepare: fixed initial call stack positions
            const stack_base = self._stack.Push(undefined); // 0 return value (placeholder)
            //@ts-ignore
            self._stack.Push(this); // 1 this (not an error, it's intentionally to be the original this)
            self._stack.Push(data); // 2 data
            self._stack.Push(undefined); // 3 new.target
            // prepare: arguments
            const argc = arguments.length;
            for (let i = 0; i < argc; ++i) {
                self._stack.Push(arguments[i]);
                // jsbb_console.log(`call_function.arg[${i}] = ${arguments[i]}`);
            }
            try {
                // jsbb_console.log("call_function.pre", func_name, self._opaque, cb, stack_base, argc);
                _jsbb_.interop.call_function(self._opaque, cb, false, stack_base, argc);
                self.rethrow_native_error();
                // jsbb_console.log("call_function.post", func_name);
            }
            catch (err) {
                jsbb_console.error("NewCFunction.call_function error:", func_name, typeof err, err);
                // cleanup 
                self._stack.ExitScope();
                // in javascript execution context
                throw err;
            }
            const rval = self._stack.GetValue(stack_base);
            // jsbb_console.log("call_function.return", rval);
            // cleanup
            self._stack.ExitScope();
            return rval;
        });
    }
    // generate a constructor wrapper function for native class
    NewClass(cb, data_sp, internal_field_count, class_name_ptr) {
        const self = this;
        const data = this._stack.GetValue(data_sp);
        const class_name = class_name_ptr == 0 ? "(CClass)" : _jsbb_.wasmop.UTF8ToString(class_name_ptr);
        // jsbb_console.log("NewClass", class_name, cb, data);
        const ctor = function () {
            // jsbb_console.log("new class", class_name);
            self._stack.EnterScope();
            const target = new.target;
            const is_construct_call = target !== undefined;
            // prepare: fixed initial call stack positions
            const rval_pos = self._stack.Push(undefined); // 0 return value (placeholder)
            //@ts-ignore
            self._stack.Push(this); // 1 this (not an error, it's intentionally to be the original this)
            self._stack.Push(data); // 2 data
            self._stack.Push(target); // 3 new.target
            // prepare: arguments
            const argc = arguments.length;
            for (let i = 0; i < argc; ++i) {
                self._stack.Push(arguments[i]);
            }
            // register the instance with unique internal data
            const internal_data = _jsbb_.interop.generate_internal_data(self._opaque, internal_field_count);
            //@ts-ignore
            self._registry.Add(this, internal_data);
            try {
                jsbb_console.log("new class dispatch", class_name, cb, is_construct_call, rval_pos, argc, internal_data);
                _jsbb_.interop.call_function(self._opaque, cb, is_construct_call, rval_pos, argc);
                self.rethrow_native_error();
            }
            catch (err) {
                jsbb_console.error("NewClass.call_function error:", class_name, err);
                // cleanup 
                self._stack.ExitScope();
                // in javascript execution context
                throw err;
            }
            const rval = self._stack.GetValue(rval_pos);
            // jsbb_console.log("NewClass.return", rval);
            // cleanup
            self._stack.ExitScope();
            return rval;
        };
        ctor[jsbb_internal_field_count] = internal_field_count;
        return this._stack.Push(ctor);
    }
    // simulate the behaviour of JS_NewObjectProtoClass
    NewInstance(proto_sp) {
        try {
            const proto = this._stack.GetValue(proto_sp);
            const thiz = {};
            const internal_field_count = proto.constructor[jsbb_internal_field_count];
            Object.setPrototypeOf(thiz, proto);
            // register the instance with unique internal data
            const internal_data = _jsbb_.interop.generate_internal_data(this._opaque, internal_field_count);
            this._registry.Add(thiz, internal_data);
            return this._stack.Push(thiz);
        }
        catch (err) {
            this._throw(err);
            return jsbb_StackPos.Error;
        }
        // return this._stack.Push(new proto.constructor());
    }
    NewObject() {
        return this._stack.Push({});
    }
    SetConstructor(func_sp, proto_sp) {
        try {
            const p = this._stack.GetValue(proto_sp);
            const f = this._stack.GetValue(func_sp);
            f.prototype = p;
            p.constructor = f;
            return 1;
        }
        catch (err) {
            this._throw(err);
            return -1;
        }
    }
    SetPrototype(proto_sp, parent_sp) {
        try {
            const proto = this._stack.GetValue(proto_sp);
            const parent = this._stack.GetValue(parent_sp);
            proto.__proto__ = parent;
            proto.constructor.__proto__ = parent;
            // should be equivalent to the above 
            // Object.setPrototypeOf(proto, parent);
            // Object.setPrototypeOf(proto.constructor, parent);
            return 1;
        }
        catch (err) {
            this._throw(err);
            return -1;
        }
    }
}
class _jsbb_ {
    static get u8() {
        if (wasmMemory.buffer != HEAP8.buffer) {
            updateMemoryViews();
        }
        return HEAPU8;
    }
    static get i32() {
        if (wasmMemory.buffer != HEAP8.buffer) {
            updateMemoryViews();
        }
        return HEAP32;
    }
    //TODO may not be supported?
    static get i64() {
        if (wasmMemory.buffer != HEAP8.buffer) {
            updateMemoryViews();
            this._i64 = new BigInt64Array(wasmMemory.buffer);
        }
        return this._i64;
    }
    static init(interop) {
        jsbb_console.log("init jsbb");
        if (typeof interop === "undefined") {
            jsbb_console.error("invalid interop");
        }
        if (typeof this.interop !== "undefined") {
            jsbb_console.error("Already initialized, do not call it twice");
        }
        try {
            this.interop = {
                gc_callback: GodotRuntime.get_func(interop.gc_callback),
                unhandled_rejection: GodotRuntime.get_func(interop.unhandled_rejection),
                call_function: GodotRuntime.get_func(interop.call_function),
                call_accessor: GodotRuntime.get_func(interop.call_accessor),
                generate_internal_data: GodotRuntime.get_func(interop.generate_internal_data),
            };
            //@ts-ignore
            this.wasmop = { UTF8ToString, stringToUTF8, lengthBytesUTF8, _malloc, _free };
            for (let key in this.interop) {
                //@ts-ignore
                jsbb_console.log("define jsbi.interop", key, typeof this.interop[key]);
            }
            for (let key in this.wasmop) {
                //@ts-ignore
                jsbb_console.log("define jsbi.wasmop", key, typeof this.wasmop[key]);
            }
        }
        catch (err) {
            jsbb_console.error("unexpected error:", err);
        }
    }
    static NewEngine(opaque) {
        if (typeof this.engine !== "undefined") {
            jsbb_console.error("temporarily support only one engine");
            return -1;
        }
        // currectly, engine_id is hardcoded.
        // only one single engine is supported to new simultaneously
        this.engine = new jsbb_Engine(0, opaque);
        return 0;
    }
    static FreeEngine(engine_id) {
        if (engine_id !== 0) {
            jsbb_console.error("invalid engine id");
            return;
        }
        this.engine.Release();
        this.engine = undefined;
    }
    static GetEngine(engine_id) {
        if (engine_id !== 0) {
            jsbb_console.error("invalid engine id");
            return undefined;
        }
        return this.engine;
    }
    static is_object(val) {
        //NOTE IsObject() expects a class (constructor, a function) as an Object 
        return typeof val === "object" || typeof val === "function";
    }
    static free(ptr) {
        this.wasmop._free(ptr);
    }
    static debugbreak() {
        jsbb_console.trace("debugbreak");
    }
    static log(ptr) {
        if (typeof UTF8ToString === "function") {
            let str = UTF8ToString(ptr);
            if (typeof str === "string" && str.length > 0) {
                console.log(str);
            }
        }
    }
    static error(ptr) {
        if (typeof UTF8ToString === "function") {
            let str = UTF8ToString(ptr);
            if (typeof str === "string" && str.length > 0) {
                console.error(str);
            }
        }
    }
}
_jsbb_.evalResult = undefined;
const jsbb_browser = (typeof globalThis === "object" && globalThis) || (typeof window === "object" && window) || (typeof global === "object" && global);
jsbb_browser["_jsbb_"] = _jsbb_;
