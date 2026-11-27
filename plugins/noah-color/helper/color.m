#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>

static int sampleColor(void) {
    [NSApplication sharedApplication];
    NSColorSampler *sampler = [[NSColorSampler alloc] init];
    [sampler showSamplerWithSelectionHandler:^(NSColor *selection) {
        NSColor *color = [selection colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
        if (color) {
            printf("#%02lX%02lX%02lX\n",
                   lround(fmin(1, fmax(0, color.redComponent)) * 255),
                   lround(fmin(1, fmax(0, color.greenComponent)) * 255),
                   lround(fmin(1, fmax(0, color.blueComponent)) * 255));
        }
        exit(EXIT_SUCCESS);
    }];
    [NSApp run];
    return EXIT_FAILURE;
}

static int imagePixels(const char *path) {
    CGImageSourceRef source;
    if (path) {
        NSURL *url = [NSURL fileURLWithPath:[[NSFileManager defaultManager] stringWithFileSystemRepresentation:path length:strlen(path)]];
        source = CGImageSourceCreateWithURL((__bridge CFURLRef)url, NULL);
    } else {
        NSPasteboard *clipboard = NSPasteboard.generalPasteboard;
        NSData *data = [clipboard dataForType:NSPasteboardTypePNG] ?: [clipboard dataForType:NSPasteboardTypeTIFF];
        if (!data) return EXIT_FAILURE;
        source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    }
    if (!source) return EXIT_FAILURE;
    NSDictionary *options = @{
        (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @96,
        (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES
    };
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    CFRelease(source);
    if (!image) return EXIT_FAILURE;

    size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
    CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, space,
                                                   kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    CGColorSpaceRelease(space);
    if (!context) {
        CGImageRelease(image);
        return EXIT_FAILURE;
    }

    CGContextDrawImage(context, CGRectMake(0, 0, width, height), image);
    CGImageRelease(image);
    printf("%zu %zu\n", width, height);
    size_t count = fwrite(CGBitmapContextGetData(context), 4, width * height, stdout);
    CGContextRelease(context);
    return count == width * height ? EXIT_SUCCESS : EXIT_FAILURE;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "sample") == 0) return sampleColor();
        if (argc == 3 && strcmp(argv[1], "pixels") == 0) return imagePixels(argv[2]);
        if (argc == 2 && strcmp(argv[1], "clipboard") == 0) return imagePixels(NULL);
        return EXIT_FAILURE;
    }
}
