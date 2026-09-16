/** Scope PS 23 Auto-Size Canvas changes and verify geometry after managed edits. */
export const ARTBOARD_SCOPED_TOOLS = new Set([
  'photoshop_create_layer', 'photoshop_create_text_layer', 'photoshop_select_layer_by_name',
  'photoshop_rename_layer', 'photoshop_set_layer_opacity', 'photoshop_set_layer_visibility',
  'photoshop_set_layer_locked', 'photoshop_set_layer_blend_mode', 'photoshop_update_text_content',
  'photoshop_set_text_font', 'photoshop_set_text_color', 'photoshop_set_text_alignment',
]);

export const artboardMutationGuard = `
var __mcpArtboardScope = null;
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
  function geometry() {
    var parts = [doc.width.as('px'), doc.height.as('px')];
    for (var i = 0; i < doc.layerSets.length; i++) {
      var layer = doc.layerSets[i], r = new ActionReference();
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
  return {
    touched: false,
    begin: function() { this.touched = true; set([false, false, false]); },
    restore: function() { if (this.touched) { set(old); this.touched = false; } },
    verify: function() {
      if (geometry() !== before)
        throw new Error('artboard_geometry_changed: canvas or artboard bounds changed; inspect partial results before recovery');
    }
  };
}
`;
