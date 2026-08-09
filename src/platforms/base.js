function definePlatform(def) {
  def.available = Boolean(def.available);
  def.missing = def.missing || null;
  def.connectNote = def.connectNote || null;
  def.buildAuthorizeUrl = def.buildAuthorizeUrl || null;
  def.handleCallback = def.handleCallback || null;
  def.publish = def.publish || null;
  def.refresh = def.refresh || null;
  return def;
}module.exports = { definePlatform };
