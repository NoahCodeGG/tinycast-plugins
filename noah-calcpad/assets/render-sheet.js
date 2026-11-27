ObjC.import("AppKit");

function run(argv) {
  const [input, output] = argv;
  const source = $.NSString.stringWithContentsOfFileEncodingError(input, $.NSUTF8StringEncoding, null);
  const sheet = JSON.parse(ObjC.unwrap(source));
  const width = 760;
  const margin = 36;
  const contentWidth = width - margin * 2;
  const resultWidth = 260;
  const gap = 20;
  const formulaWidth = contentWidth - resultWidth - gap;
  const options = $.NSStringDrawingUsesLineFragmentOrigin | $.NSStringDrawingUsesFontLeading;
  const ink = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.10, 0.16, 0.20, 1);
  const muted = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.29, 0.36, 0.39, 1);
  const accent = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.04, 0.38, 0.32, 1);
  const errorInk = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.65, 0.20, 0.15, 1);
  const rule = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.85, 0.89, 0.88, 1);
  const background = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0.97, 0.98, 0.97, 1);

  function text(value, size, color, columnWidth, right) {
    const paragraph = $.NSMutableParagraphStyle.alloc.init;
    paragraph.lineBreakMode = $.NSLineBreakByCharWrapping;
    paragraph.alignment = right ? $.NSTextAlignmentRight : $.NSTextAlignmentLeft;
    const attributes = $.NSMutableDictionary.alloc.init;
    attributes.setObjectForKey($.NSFont.systemFontOfSize(size), $.NSFontAttributeName);
    attributes.setObjectForKey(color, $.NSForegroundColorAttributeName);
    attributes.setObjectForKey(paragraph, $.NSParagraphStyleAttributeName);
    const label = $(value);
    const bounds = label.boundingRectWithSizeOptionsAttributes($.NSMakeSize(columnWidth, 100000), options, attributes);
    return { label, attributes, width: columnWidth, height: Math.ceil(bounds.size.height) + 2 };
  }

  const heading = text(sheet.title, 30, ink, contentWidth, false);
  const lines = sheet.rows.map((row) => {
    const formula = text(String(row.line) + (row.formula ? "   " + row.formula : ""), 18, ink, formulaWidth, false);
    const result = row.value !== undefined ? "= " + row.value : row.error || "";
    const value = result ? text(result, 18, row.error ? errorInk : accent, resultWidth, true) : null;
    const note = row.note ? text(row.note, 15, muted, contentWidth - 30, false) : null;
    const topHeight = Math.max(formula.height, value ? value.height : 0);
    return { formula, value, note, topHeight, height: topHeight + (note ? note.height + 6 : 0) + 24 };
  });
  const empty = lines.length ? null : text("空白稿纸", 16, muted, contentWidth, false);
  const bodyHeight = empty ? empty.height : lines.reduce((sum, line) => sum + line.height, 0);
  const height = margin * 2 + heading.height + 24 + bodyHeight;
  const image = $.NSImage.alloc.initWithSize($.NSMakeSize(width, height));

  function draw(item, left, top) {
    item.label.drawWithRectOptionsAttributes(
      $.NSMakeRect(left, height - top - item.height, item.width, item.height), options, item.attributes
    );
  }

  image.lockFocus;
  try {
    background.setFill;
    $.NSBezierPath.fillRect($.NSMakeRect(0, 0, width, height));
    draw(heading, margin, margin);
    let top = margin + heading.height + 24;
    if (empty) draw(empty, margin, top);
    for (const line of lines) {
      rule.setFill;
      $.NSBezierPath.fillRect($.NSMakeRect(margin, height - top, contentWidth, 1));
      draw(line.formula, margin, top + 12);
      if (line.value) draw(line.value, margin + formulaWidth + gap, top + 12);
      if (line.note) draw(line.note, margin + 30, top + 18 + line.topHeight);
      top += line.height;
    }
  } finally {
    image.unlockFocus;
  }

  const bitmap = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.alloc.init);
  if (!png.writeToFileAtomically(output, true)) throw new Error("Cannot write the PNG");
}
