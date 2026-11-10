# Exportiert das Maskottchen aus der .blend als GLB fuer Pixor. Laeuft headless und speichert die .blend nicht:
#   blender -b crow.blend --factory-startup --python-exit-code 1 --python export.py -- out.glb
#
# Exportiert werden die Meshes mit Armature-Modifier und ihre Armatures, sonst nichts (Kamera, Lichter, Boden, Bone-Shapes).
# Jede Action wird ein Clip, Zeit 0 ist ihr erster Key; fehlende Clips erzeugt animate.py. Zwei Korrekturen nur fuer den Export:
# - glTF kennt nur Principled: Diffuse-, Glossy- und andere Shader werden zu Principled mit derselben Farbe.
# - Skinning braucht das Armature als Eltern: Meshes ohne werden ihm untergeordnet, die Weltlage bleibt.

import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import animate  # noqa: E402

out = sys.argv[sys.argv.index("--") + 1]



# Fehlende Clips aus animate.py erzeugen; Actions aus der .blend gewinnen.
made = animate.ensure_clips()
print("export.py: erzeugt " + json.dumps(made))

meshes = [o for o in bpy.data.objects if o.type == "MESH" and any(m.type == "ARMATURE" and m.object for m in o.modifiers)]
rigs = {m.object for o in meshes for m in o.modifiers if m.type == "ARMATURE" and m.object}
if not meshes:
    sys.exit("export.py: kein Mesh mit Armature-Modifier gefunden")

for o in meshes:
    rig = next(m.object for m in o.modifiers if m.type == "ARMATURE" and m.object)
    if o.parent != rig:
        world = o.matrix_world.copy()
        o.parent = rig
        o.matrix_world = world

materials = {slot.material for o in meshes for slot in o.material_slots if slot.material}
for m in materials:
    if not m.node_tree:
        continue
    nt = m.node_tree
    output = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    link = next((l for l in nt.links if output and l.to_node == output and l.to_socket.name == "Surface"), None)
    shader = link.from_node if link else None
    if shader is None or shader.type == "BSDF_PRINCIPLED":
        continue
    colour = tuple(shader.inputs["Color"].default_value) if "Color" in shader.inputs else (0.8, 0.8, 0.8, 1.0)
    principled = nt.nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = colour
    principled.inputs["Roughness"].default_value = 0.25 if shader.type == "BSDF_GLOSSY" else 0.6
    nt.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    print(f"export.py: Material {m.name}: {shader.type} -> Principled")

# Teile, die ein eigenes Material bekommen, damit Pixor sie anders einfaerben kann (--material-ramp NAME=...):
# Flaechen, deren Vertices im Mittel zu mindestens der Haelfte an Bones mit diesem Praefix haengen; spaetere Teile
# gewinnen (die Federspitzen an wing.*.c4-c6 nach dem ganzen Fluegel).
PARTS = {"wing": ("wing.",), "wingtip": tuple(f"wing.{s}.c{i}" for s in "LR" for i in (4, 5, 6))}
for part, prefixes in PARTS.items():
    for o in meshes:
        groups = {g.index for g in o.vertex_groups if g.name.startswith(prefixes)}
        share = [sum(g.weight for g in v.groups if g.group in groups) / max(sum(g.weight for g in v.groups), 1e-6) for v in o.data.vertices]
        faces = [p for p in o.data.polygons if sum(share[i] for i in p.vertices) / len(p.vertices) >= 0.5]
        if not faces:
            continue
        source = o.data.materials[faces[0].material_index]
        material = source.copy() if source else bpy.data.materials.new(part)
        material.name = part
        o.data.materials.append(material)
        index = len(o.data.materials) - 1
        for p in faces:
            p.material_index = index
        print(f"export.py: {o.name}: {len(faces)} Flaechen -> Material {part}")

# Schnabel und Fuesse teilen sich Material.003. Der Schnabel bekommt eine Kopie namens "beak", damit Pixor ihn anders
# einfaerben kann als die Fuesse: das Objekt "beak" ganz, vom Koerper die Flaechen mit Material.003, die ueberwiegend an
# den Schnabel-Bones haengen (der Unterschnabel, sonst beim offenen Schnabel grau wie die Fuesse).
beak = None
for o in meshes:
    feet = next((m for m in o.data.materials if m and m.name == "Material.003"), None)
    if feet is None:
        continue
    if beak is None:
        beak = feet.copy()
        beak.name = "beak"
    slot = list(o.data.materials).index(feet)
    if o.name == "beak":
        faces = [p for p in o.data.polygons if p.material_index == slot]
    else:
        groups = {g.index for g in o.vertex_groups if g.name.lower().startswith("beak")}
        share = [sum(g.weight for g in v.groups if g.group in groups) / max(sum(g.weight for g in v.groups), 1e-6) for v in o.data.vertices]
        faces = [p for p in o.data.polygons if p.material_index == slot and sum(share[i] for i in p.vertices) / len(p.vertices) >= 0.5]
    if not faces:
        continue
    o.data.materials.append(beak)
    for p in faces:
        p.material_index = len(o.data.materials) - 1
    print(f"export.py: {o.name}: {len(faces)} Flaechen -> Material beak")
    # Der Unterschnabel (an "Beak c2") bekommt ein eigenes Material "beaklow": Pixor faerbt Ober- und Unterschnabel dann in
    # festen Toenen statt nach Licht, dessen Kante auf dem kleinen Schnabel jeden Frame springt.
    low = {g.index for g in o.vertex_groups if g.name == "Beak c2"}
    if low:
        share = [sum(g.weight for g in v.groups if g.group in low) / max(sum(g.weight for g in v.groups), 1e-6) for v in o.data.vertices]
        lower = [p for p in faces if sum(share[i] for i in p.vertices) / len(p.vertices) >= 0.5]
        if lower:
            beaklow = bpy.data.materials.get("beaklow") or beak.copy()
            beaklow.name = "beaklow"
            o.data.materials.append(beaklow)
            for p in lower:
                p.material_index = len(o.data.materials) - 1
            print(f"export.py: {o.name}: {len(lower)} Flaechen -> Material beaklow")

for o in bpy.data.objects:
    o.select_set(o in meshes or o in rigs)
bpy.context.view_layer.objects.active = next(iter(rigs))

options = dict(filepath=out, export_format="GLB", use_selection=True, export_apply=False,
               export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
               export_anim_slide_to_zero=True, export_rest_position_armature=False)
known = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
bpy.ops.export_scene.gltf(**{k: v for k, v in options.items() if k in known})

actions = [{"name": a.name, "start": a.frame_range[0], "end": a.frame_range[1]} for a in bpy.data.actions]
print("export.py: actions " + json.dumps(actions))
print(f"export.py: {out}")
