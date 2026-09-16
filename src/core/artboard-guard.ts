/** PS 23 can silently resize an artboard canvas when adding even an empty layer. */
export const artboardMutationGuard = `
if (app.documents.length) {
  var __mcpGroups = app.activeDocument.layerSets;
  for (var __mcpGroupIndex = 0; __mcpGroupIndex < __mcpGroups.length; __mcpGroupIndex++) {
    var __mcpRef = new ActionReference();
    __mcpRef.putIdentifier(charIDToTypeID('Lyr '), __mcpGroups[__mcpGroupIndex].id);
    var __mcpDesc = executeActionGet(__mcpRef);
    if (__mcpDesc.hasKey(stringIDToTypeID('artboard'))) {
      throw new Error('unsupported_artboard_mutation: managed edits are disabled for artboard documents because Photoshop can silently resize the canvas; read, preview, save and close remain available. Arbitrary JSX is trusted execution, not a safe workaround.');
    }
  }
}
`;
