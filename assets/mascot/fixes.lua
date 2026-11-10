-- Handkorrekturen am fertigen Sheet, laeuft in Aseprite ohne Oberflaeche (build.mjs):
--   Aseprite -b --script-param render=out/sheet.png --script-param file=fixes.aseprite --script-param out=out/final.png
--                --script-param cell=32 --script fixes.lua
--
-- fixes.aseprite hat drei Ebenen:
--   render  das gerenderte Sheet; wird bei jedem Build ersetzt, hier nichts malen
--   erase   jedes Pixel hier (Farbe egal) loescht das Pixel darunter im Render
--   fix     wird ueber den Render gemalt
-- Ergebnis: render ohne erase, darueber fix -> out.

local p = app.params
local render = Image{ fromFile = p.render }
local cell = tonumber(p.cell or "32")

local sprite
if app.fs.isFile(p.file) then
  sprite = app.open(p.file)
else
  sprite = Sprite(render.width, render.height, ColorMode.RGB)
  sprite.layers[1].name = "render"
  local erase = sprite:newLayer()
  erase.name = "erase"
  erase.opacity = 128
  local fix = sprite:newLayer()
  fix.name = "fix"
end
sprite.gridBounds = Rectangle(0, 0, cell, cell)

local function layer(name)
  for _, l in ipairs(sprite.layers) do
    if l.name == name then return l end
  end
  error("fixes.aseprite: Ebene '" .. name .. "' fehlt")
end

-- Hat noch niemand korrigiert, passt sich die Datei einem anders grossen Sheet an; sonst muss der Mensch entscheiden.
local function painted()
  for _, name in ipairs({ "erase", "fix" }) do
    local c = layer(name):cel(1)
    if c and not c.image:isEmpty() then return true end
  end
  return false
end
if (sprite.width ~= render.width or sprite.height ~= render.height) and not painted() then
  sprite:resize(render.width, render.height)
end
if sprite.width ~= render.width or sprite.height ~= render.height then
  error(string.format("fixes.aseprite ist %dx%d, das Sheet %dx%d", sprite.width, sprite.height, render.width, render.height))
end

local renderLayer = layer("render")
sprite:newCel(renderLayer, 1, render, Point(0, 0))
renderLayer.isEditable = false

-- import=PNG: ein von Hand bereinigtes fertiges Sheet. Alles, was es vom Render unterscheidet, wird zu fix (andere oder
-- neue Pixel) und erase (entfernte Pixel); bisherige Korrekturen ersetzt es, denn das PNG enthaelt sie schon.
if p.import and p.import ~= "" then
  local cleaned = Image{ fromFile = p.import }
  if cleaned.width ~= render.width or cleaned.height ~= render.height then
    error(string.format("%s ist %dx%d, das Sheet %dx%d", p.import, cleaned.width, cleaned.height, render.width, render.height))
  end
  local fixImage = Image(render.width, render.height, ColorMode.RGB)
  local eraseImage = Image(render.width, render.height, ColorMode.RGB)
  local mark = app.pixelColor.rgba(255, 0, 0, 255)
  for y = 0, render.height - 1 do
    for x = 0, render.width - 1 do
      local was, now = render:getPixel(x, y), cleaned:getPixel(x, y)
      if was ~= now then
        if app.pixelColor.rgbaA(now) == 0 then
          eraseImage:drawPixel(x, y, mark)
        else
          fixImage:drawPixel(x, y, now)
        end
      end
    end
  end
  sprite:newCel(layer("fix"), 1, fixImage, Point(0, 0))
  sprite:newCel(layer("erase"), 1, eraseImage, Point(0, 0))
end

local function celImage(l)
  local c = l:cel(1)
  if c == nil then return nil, nil end
  return c.image, c.position
end

local result = Image(render.width, render.height, ColorMode.RGB)
result:drawImage(render, Point(0, 0))

local erase, at = celImage(layer("erase"))
local erased = 0
if erase then
  for it in erase:pixels() do
    if app.pixelColor.rgbaA(it()) > 0 then
      local x, y = it.x + at.x, it.y + at.y
      if x >= 0 and y >= 0 and x < result.width and y < result.height then
        result:drawPixel(x, y, app.pixelColor.rgba(0, 0, 0, 0))
        erased = erased + 1
      end
    end
  end
end

local fix, fat = celImage(layer("fix"))
local painted = 0
if fix then
  result:drawImage(fix, fat, 255, BlendMode.NORMAL)
  for it in fix:pixels() do
    if app.pixelColor.rgbaA(it()) > 0 then painted = painted + 1 end
  end
end

sprite:saveAs(p.file)
result:saveAs(p.out)
print(string.format("fixes.lua: %d Pixel geloescht, %d Pixel gemalt", erased, painted))
