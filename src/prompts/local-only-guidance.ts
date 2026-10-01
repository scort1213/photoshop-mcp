/** Guidance for trusted custom scripts and actions; this is not a sandbox. */
export const LOCAL_ONLY_GUIDANCE = `Local operation policy
- Use only local Photoshop editing and files already available on this computer.
- Fixed-tool paths must be native absolute paths to real local files, including
  image references in XML/CSV. Do not use relative paths, ~, Finder aliases,
  shortcuts, network volumes or encoded URI input. Literal percent signs in
  native filenames are supported; the server handles Adobe path encoding.
- photoshop_close_document with save:true saves a local copy and keeps the
  document open (saved:true, closed:false). Tell the user it remains open.
  Do not automatically follow this with save:false or custom close code;
  closing/discarding requires the user's separate decision.
- Do not call Firefly, generative features, Neural Filters, cloud document or
  Creative Cloud Libraries operations, online asset downloads, or online font activation.
- Do not sign in, validate accounts or API keys, open login pages or browsers,
  send network requests, or invoke external commands to reach those services.
- Select Subject, background removal and passport-photo workflows require
  Photoshop Settings/Preferences > Image Processing > Select Subject and
  Remove Background to be set to Device. Never switch it to Cloud. If the
  setting has not been confirmed, ask for that setting or use a manual selection.
- If a local operation fails or a local asset/font is missing, use another
  local method or explain the missing requirement. Never fall back to a cloud service.
- Apply this policy to custom JSX and every step of recorded actions as well.
  Custom scripts and recorded actions remain trusted, unsandboxed code: these
  instructions guide the calling assistant and do not technically prevent a bypass.
- Adobe's own licensing/background services and the AI host's model processing
  are outside this MCP policy.`;
