/*
 * win-bounds.c — 获取 macOS 屏幕上所有可见应用窗口的位置和大小
 *
 * 编译（由 main.js 在后台自动完成）：
 *   /usr/bin/cc -framework CoreFoundation -framework CoreGraphics win-bounds.c -o win-bounds
 *
 * 输出：JSON array，坐标为逻辑像素（点），原点 = 主屏幕左上角
 *   [{"name":"Safari","x":100,"y":50,"width":1200,"height":800}, ...]
 *
 * 不需要辅助功能权限。CGWindowListCopyWindowInfo 可直接访问。
 */

#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <string.h>

/* 最简 JSON 字符串转义：处理双引号、反斜线、控制字符 */
static void escapeJson(const char *in, char *out, int outLen) {
    int j = 0;
    for (int i = 0; in[i] && j < outLen - 3; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c < 0x20) continue;
        if (c == '"' || c == '\\') out[j++] = '\\';
        out[j++] = in[i];
    }
    out[j] = '\0';
}

int main(void) {
    CGWindowListOption opts =
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    CFArrayRef list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID);
    if (!list) { puts("[]"); return 0; }

    CFIndex n   = CFArrayGetCount(list);
    int     sep = 0;
    printf("[");

    for (CFIndex i = 0; i < n; i++) {
        CFDictionaryRef w = CFArrayGetValueAtIndex(list, i);

        /* 只处理普通应用层（layer == 0），过滤菜单栏/Dock/桌面 */
        CFNumberRef layerRef = CFDictionaryGetValue(w, kCGWindowLayer);
        int layer = 0;
        if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
        if (layer != 0) continue;

        /* 边界矩形 */
        CFDictionaryRef bdRef = CFDictionaryGetValue(w, kCGWindowBounds);
        if (!bdRef) continue;
        CGRect rect;
        if (!CGRectMakeWithDictionaryRepresentation(bdRef, &rect)) continue;

        /* 过滤尺寸过小的辅助窗口 */
        if (rect.size.width < 80 || rect.size.height < 80) continue;

        /* 应用名称 */
        char name[512] = "";
        CFStringRef nameRef = CFDictionaryGetValue(w, kCGWindowOwnerName);
        if (nameRef)
            CFStringGetCString(nameRef, name, (CFIndex)sizeof(name),
                               kCFStringEncodingUTF8);

        char escaped[1024];
        escapeJson(name, escaped, (int)sizeof(escaped));

        if (sep) printf(",");
        sep = 1;
        printf("{\"name\":\"%s\",\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d}",
               escaped,
               (int)rect.origin.x,   (int)rect.origin.y,
               (int)rect.size.width, (int)rect.size.height);
    }

    printf("]\n");
    CFRelease(list);
    return 0;
}
