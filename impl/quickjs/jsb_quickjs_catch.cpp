#include "jsb_quickjs_catch.h"
#include "jsb_quickjs_isolate.h"
#include "jsb_quickjs_ext.h"

namespace jsb::impl
{
    bool TryCatch::has_caught() const
    {
        return isolate_->try_catch();
    }

    void TryCatch::get_message(String* r_message, String* r_stacktrace) const
    {
        JSContext* ctx = isolate_->ctx();
        const JSValue ex = isolate_->stack_val(StackPos::Exception);
        jsb_check(!JS_IsNull(ex));

        const JSValue err_filename = JS_GetProperty(ctx, ex, JS_ATOM_fileName);
        const JSValue err_line = JS_GetProperty(ctx, ex, JS_ATOM_lineNumber);
        const JSValue err_message = JS_GetProperty(ctx, ex, JS_ATOM_message);
        const JSValue err_stack = JS_GetProperty(ctx, ex, JS_ATOM_stack);

        {
            const String filename = QuickJS::IsNullish(err_filename) ? String("native") : QuickJS::GetString(ctx, err_filename);
            const String line = QuickJS::IsNullish(err_line) ? String("") : QuickJS::GetString(ctx, err_line);
            const String message = QuickJS::GetString(ctx, err_message);
            const String stack = QuickJS::GetString(ctx, err_stack);

            JSB_QUICKJS_LOG(Error, "[%s:%s] %s\nJavascript stack:\n%s", filename, line, message, stack);
            if (r_message) *r_message = message;
            if (r_stacktrace) *r_stacktrace = stack;
        }

        JS_FreeValue(ctx, err_filename);
        JS_FreeValue(ctx, err_line);
        JS_FreeValue(ctx, err_message);
        JS_FreeValue(ctx, err_stack);

        // reset current exception
        isolate_->stack_copy(StackPos::Exception, StackPos::Null);
    }


}
