/** Scope PS 23 Auto-Size Canvas changes and verify geometry after managed edits. */
export const ARTBOARD_GEOMETRY_TOOLS = new Set([
  'photoshop_resize_image', 'photoshop_crop_document', 'photoshop_merge_visible_layers', 'photoshop_flatten_image',
]);
export const ARTBOARD_SCOPED_TOOLS = new Set([
  ...ARTBOARD_GEOMETRY_TOOLS,
  'photoshop_save_document',
  'photoshop_create_layer', 'photoshop_create_text_layer', 'photoshop_select_layer_by_name',
  'photoshop_rename_layer', 'photoshop_set_layer_opacity', 'photoshop_set_layer_visibility',
  'photoshop_set_layer_locked', 'photoshop_set_layer_blend_mode', 'photoshop_update_text_content',
  'photoshop_set_text_font', 'photoshop_set_text_color', 'photoshop_set_text_alignment',
]);

export const artboardMutationGuard = `
var __mcpArtboardScope = null;
var __mcpVerifiedBackup = null;
if (app.documents.length) {
  var __mcpGroups = app.activeDocument.layerSets;
  for (var __mcpGroupIndex = 0; __mcpGroupIndex < __mcpGroups.length; __mcpGroupIndex++) {
    var __mcpRef = new ActionReference();
    __mcpRef.putIdentifier(charIDToTypeID('Lyr '), __mcpGroups[__mcpGroupIndex].id);
    var __mcpDesc = executeActionGet(__mcpRef);
    if (__mcpDesc.hasKey(stringIDToTypeID('artboard'))) {
      if (typeof __mcpArtboardAllowed !== 'undefined' && !__mcpArtboardAllowed)
        throw new Error('unsupported_artboard_mutation: this operation has not been certified for artboard geometry; supported layer and text edits remain available');
      __mcpArtboardScope = __mcpCreateArtboardScope(app.activeDocument);
      break;
    }
  }
}
function __mcpCreateArtboardScope(doc) {
  var operation = typeof __mcpArtboardOperation !== 'undefined' ? __mcpArtboardOperation : null;
  function get() {
    var r = new ActionReference();
    r.putProperty(stringIDToTypeID('property'), stringIDToTypeID('artboards'));
    r.putIdentifier(stringIDToTypeID('document'), doc.id);
    return executeActionGet(r).getObjectValue(stringIDToTypeID('artboards'));
  }
  var keys = ['autoExpandEnabled', 'autoNestEnabled', 'autoPositionEnabled'];
  function set(values) {
    var r = new ActionReference();
    r.putProperty(stringIDToTypeID('property'), stringIDToTypeID('artboards'));
    r.putIdentifier(stringIDToTypeID('document'), doc.id);
    var d = new ActionDescriptor(), a = new ActionDescriptor();
    d.putReference(charIDToTypeID('null'), r);
    for (var i = 0; i < keys.length; i++) a.putBoolean(stringIDToTypeID(keys[i]), values[i]);
    d.putObject(charIDToTypeID('T   '), stringIDToTypeID('artboards'), a);
    executeAction(charIDToTypeID('setd'), d, DialogModes.NO);
    var actual = get();
    for (var i = 0; i < keys.length; i++) {
      if (actual.getBoolean(stringIDToTypeID(keys[i])) !== values[i])
        throw new Error('artboard_settings_failed: ' + keys[i] + ' did not match requested value');
    }
  }
  function geometry(target) {
    target = target || doc;
    var parts = [target.width.as('px'), target.height.as('px')];
    for (var i = 0; i < target.layerSets.length; i++) {
      var layer = target.layerSets[i], r = new ActionReference();
      r.putIdentifier(charIDToTypeID('Lyr '), layer.id);
      var d = executeActionGet(r);
      if (!d.hasKey(stringIDToTypeID('artboard'))) continue;
      var rect = d.getObjectValue(stringIDToTypeID('artboard')).getObjectValue(stringIDToTypeID('artboardRect'));
      parts.push(layer.id, rect.getDouble(stringIDToTypeID('top')), rect.getDouble(stringIDToTypeID('left')),
        rect.getDouble(stringIDToTypeID('bottom')), rect.getDouble(stringIDToTypeID('right')));
    }
    return parts.join(',');
  }
  var settings = get(), old = [], before = geometry();
  for (var i = 0; i < keys.length; i++) old.push(settings.getBoolean(stringIDToTypeID(keys[i])));
  var original = before.split(','), expected = original.slice(0);
  if (operation) {
    var p = operation.args, tool = operation.tool;
    if (tool === 'photoshop_resize_image') {
      if (!(p.width >= 1 && p.height >= 1 && p.width % 1 === 0 && p.height % 1 === 0))
        throw new Error('invalid_argument: artboard resize requires positive integer pixel dimensions');
      expected[0] = p.width; expected[1] = p.height;
      for (var i = 2; i < expected.length; i += 5) {
        expected[i+1] *= p.height / Number(original[1]); expected[i+2] *= p.width / Number(original[0]);
        expected[i+3] *= p.height / Number(original[1]); expected[i+4] *= p.width / Number(original[0]);
      }
    } else if (tool === 'photoshop_crop_document') {
      if (!(p.left >= 0 && p.top >= 0 && p.right > p.left && p.bottom > p.top &&
        p.right <= Number(original[0]) && p.bottom <= Number(original[1]) &&
        p.left % 1 === 0 && p.top % 1 === 0 && p.right % 1 === 0 && p.bottom % 1 === 0))
        throw new Error('invalid_argument: artboard crop must be an integer rectangle inside the document');
      expected[0] = p.right-p.left; expected[1] = p.bottom-p.top;
      for (var i = 2; i < expected.length; i += 5) {
        expected[i+1] -= p.top; expected[i+2] -= p.left;
        expected[i+3] -= p.top; expected[i+4] -= p.left;
      }
    }
  }
  function fingerprint(target) {
    var values = [];
    function scan(parent) {
      for (var i = 0; i < parent.layers.length; i++) {
        var layer = parent.layers[i];
        values.push(layer.id, layer.name, layer.typename, layer.visible, layer.opacity);
        if (layer.typename === 'LayerSet') { values.push('['); scan(layer); values.push(']'); }
        else if (layer.kind === LayerKind.TEXT) values.push(layer.textItem.contents);
      }
    }
    scan(target); return values.toSource();
  }
  var hiddenBefore = [];
  if (operation && operation.tool === 'photoshop_merge_visible_layers') {
    function inspectVisibleGroup(group) {
      for (var n = 0; n < group.layers.length; n++) {
        var child = group.layers[n];
        if (!child.visible)
          throw new Error('unsupported_artboard_mutation: merging groups with hidden descendants is not certified; preserve them separately first');
        if (child.typename === 'LayerSet') inspectVisibleGroup(child);
      }
    }
    for (var n = 0; n < doc.layers.length; n++) {
      var root = doc.layers[n];
      if (!root.visible) hiddenBefore.push(fingerprint({ layers: [root] }));
      else if (root.typename === 'LayerSet') inspectVisibleGroup(root);
    }
  }
  function backup() {
    if (!operation) return;
    var file = new File(operation.backup);
    if (file.exists) throw new Error('backup_failed: recovery file already exists');
    var structure = fingerprint(doc), reopened = null;
    var d = new ActionDescriptor();
    d.putObject(charIDToTypeID('As  '), stringIDToTypeID('largeDocumentFormat'), new ActionDescriptor());
    d.putPath(charIDToTypeID('In  '), file); d.putBoolean(charIDToTypeID('Cpy '), true);
    executeAction(charIDToTypeID('save'), d, DialogModes.NO);
    try {
      reopened = app.open(file);
      if (geometry(reopened) !== before || fingerprint(reopened) !== structure)
        throw new Error('backup_failed: reopened recovery copy differs from current document');
    } finally {
      if (reopened) reopened.close(SaveOptions.DONOTSAVECHANGES);
      app.activeDocument = doc;
    }
    __mcpVerifiedBackup = file.fsName;
    if (Date.now() >= operation.deadline)
      throw new Error('queue_timeout: backup exceeded deadline; original edit was not started');
  }
  return {
    touched: false,
    begin: function() { this.touched = true; set([false, false, false]); backup(); },
    restore: function() { if (this.touched) { set(old); this.touched = false; } },
    verify: function() {
      var after = geometry().split(','), valid = true;
      if (operation && (operation.tool === 'photoshop_merge_visible_layers' || operation.tool === 'photoshop_flatten_image')) {
        valid = Number(after[0]) === Number(original[0]) && Number(after[1]) === Number(original[1]);
        if (operation.tool === 'photoshop_flatten_image') valid = valid && doc.layers.length === 1 && doc.layers[0].isBackgroundLayer;
        else {
          var visible = 0, hiddenAfter = [];
          for (var i = 0; i < doc.layers.length; i++) {
            if (doc.layers[i].visible) visible++;
            else hiddenAfter.push(fingerprint({ layers: [doc.layers[i]] }));
          }
          valid = valid && visible === 1 && hiddenAfter.toSource() === hiddenBefore.toSource();
        }
      } else {
        valid = after.length === expected.length;
        for (var i = 0; valid && i < after.length; i++)
          valid = Math.abs(Number(after[i]) - Number(expected[i])) <=
            (operation && operation.tool === 'photoshop_resize_image' && i >= 2 && (i-2)%5 !== 0 ? 0.51 : 0);
      }
      if (!valid)
        throw new Error('artboard_geometry_changed: canvas or artboard bounds changed; inspect partial results before recovery');
    }
  };
}
`;
