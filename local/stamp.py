"""Lossless binary-chunk patching / XML model stamping, standard library only.
Roblox formats: https://dom.rojo.space/binary.html and attributes.html.
Input: JSON on stdin; output: JSON on stdout. Never executes model scripts.
"""
import base64
import json
import struct
import sys
import xml.etree.ElementTree as ET

PARTS = set('BasePart Part MeshPart WedgePart CornerWedgePart TrussPart Seat VehicleSeat SpawnLocation UnionOperation NegateOperation PartOperation IntersectOperation Terrain SkateboardPlatform FlagStand Platform'.split())
SCRIPTS = {'BaseScript', 'Script', 'LocalScript'}
TARGETS = PARTS | SCRIPTS
MAX_SIZE = 16 * 1024 * 1024

def u32(data, pos):
    return struct.unpack_from('<I', data, pos)[0]

def packed_string(value):
    value = value.encode() if isinstance(value, str) else value
    return struct.pack('<I', len(value)) + value

def read_string(data, pos):
    length = u32(data, pos)
    end = pos + 4 + length
    if end > len(data):
        raise ValueError('Truncated string in model.')
    return data[pos + 4:end], end

def attributes(data, license_key):
    """Preserve every unrelated attribute byte for byte, replace SpecialLicense."""
    count = u32(data, 0) if data else 0
    if count > 100000:
        raise ValueError('Too many attributes.')
    pos = 4 if data else 0
    entries = []
    for _ in range(count):
        start = pos
        name, pos = read_string(data, pos)
        kind = data[pos]
        pos += 1
        fixed = {3: 1, 4: 4, 5: 4, 6: 8, 9: 8, 10: 16, 14: 4, 15: 12, 16: 8, 17: 12, 27: 8, 28: 16}
        if kind == 2:
            _, pos = read_string(data, pos)
        elif kind in fixed:
            pos += fixed[kind]
        elif kind == 20:  # CFrame: position + rotation id + optional matrix
            rotation = data[pos + 12]
            pos += 13 + (36 if rotation == 0 else 0)
        elif kind == 21:  # EnumItem: enum type name and value
            _, pos = read_string(data, pos)
            pos += 4
        elif kind in (23, 25):  # NumberSequence / ColorSequence
            length = u32(data, pos)
            pos += 4 + length * (12 if kind == 23 else 20)
        elif kind == 33:  # Font: weight, style, family, cached face id
            pos += 3
            _, pos = read_string(data, pos)
            _, pos = read_string(data, pos)
        else:
            raise ValueError(f'Unsupported attribute type 0x{kind:02x}; upload was cancelled to preserve the model.')
        if pos > len(data):
            raise ValueError('Truncated attribute.')
        if name != b'SpecialLicense':
            entries.append(data[start:pos])
    if pos != len(data):
        raise ValueError('Unexpected trailing attribute data.')
    entries.append(packed_string('SpecialLicense') + b'\x02' + packed_string(license_key))
    return struct.pack('<I', len(entries)) + b''.join(entries)

def xml_stamp(data, key):
    if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
        raise ValueError('DTD and XML entities are not supported.')
    # Comments are retained, script text / CDATA is preserved as XML text.
    parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    root = ET.fromstring(data, parser=parser)
    if root.tag != 'roblox' or root.attrib.get('version') != '4':
        raise ValueError('Expected a Roblox XML version 4 model.')
    changed = 0
    for item in root.iter('Item'):
        if item.attrib.get('class') not in TARGETS:
            continue
        props = item.find('Properties')
        if props is None:
            props = ET.Element('Properties')
            item.insert(0, props)
        matches = [p for p in props if p.attrib.get('name') == 'AttributesSerialize']
        if len(matches) > 1:
            raise ValueError('Duplicate AttributesSerialize property.')
        prop = matches[0] if matches else ET.SubElement(props, 'BinaryString', {'name': 'AttributesSerialize'})
        if prop.tag != 'BinaryString':
            raise ValueError('Unexpected AttributesSerialize property type.')
        previous = base64.b64decode(''.join((prop.text or '').split()), validate=True)
        prop.text = base64.b64encode(attributes(previous, key)).decode()
        changed += 1
    if not changed:
        raise ValueError('The model contains no BasePart or BaseScript descendants.')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True), changed

def lz4_decode(data, expected):
    output = bytearray()
    pos = 0
    def length(n):
        nonlocal pos
        if n == 15:
            while True:
                v = data[pos]
                pos += 1
                n += v
                if v != 255:
                    break
        return n
    while pos < len(data):
        token = data[pos]
        pos += 1
        literals = length(token >> 4)
        output.extend(data[pos:pos + literals])
        pos += literals
        if len(output) > expected:
            raise ValueError('Invalid LZ4 literal length.')
        if pos == len(data):
            break
        offset = struct.unpack_from('<H', data, pos)[0]
        pos += 2
        match = length(token & 15) + 4
        if offset == 0 or offset > len(output) or len(output) + match > expected:
            raise ValueError('Invalid LZ4 back reference.')
        for _ in range(match):
            output.append(output[-offset])
    if len(output) != expected:
        raise ValueError('Invalid decompressed chunk size.')
    return bytes(output)

def chunk(tag, payload):
    return tag + struct.pack('<III', 0, len(payload), 0) + payload

def binary_stamp(data, key):
    if data[:14] != b'<roblox!\x89\xff\r\n\x1a\n' or len(data) < 32:
        raise ValueError('Invalid Roblox binary header.')
    if struct.unpack_from('<H', data, 14)[0] != 0:
        raise ValueError('Unsupported Roblox binary version.')
    chunks, classes, existing = [], {}, set()
    pos, total = 32, 0
    while pos < len(data):
        start = pos
        tag = data[pos:pos + 4]
        compressed, size, reserved = struct.unpack_from('<III', data, pos + 4)
        if reserved != 0 or size > MAX_SIZE * 4:
            raise ValueError('Unsupported or oversized Roblox chunk.')
        total += size
        if total > MAX_SIZE * 8:
            raise ValueError('Model expands beyond the processing limit.')
        pos += 16
        end = pos + (compressed or size)
        if end > len(data):
            raise ValueError('Truncated Roblox chunk.')
        payload = data[pos:end]
        if compressed:
            if payload[:4] == b'\x28\xb5\x2f\xfd':
                try:
                    from compression import zstd
                except ImportError:
                    raise ValueError('Zstandard-compressed RBXM requires Python 3.14+. You can also export RBXMX from Studio.')
                decoder = zstd.ZstdDecompressor()
                payload = decoder.decompress(payload, max_length=size + 1)
                if not decoder.eof or decoder.unused_data:
                    raise ValueError('Invalid or oversized Zstandard frame.')
            else:
                payload = lz4_decode(payload, size)
        if len(payload) != size:
            raise ValueError('Roblox chunk size mismatch.')
        if tag == b'INST':
            class_id = u32(payload, 0)
            name, offset = read_string(payload, 4)
            count = u32(payload, offset + 1)
            if count > 1000000:
                raise ValueError('Too many instances in a single class.')
            classes[class_id] = (name.decode(), count)
        chunks.append((tag, payload, data[start:end]))
        pos = end
    if not chunks or chunks[-1][0] != b'END\x00':
        raise ValueError('Missing Roblox END chunk.')
    targets = {i: count for i, (name, count) in classes.items() if name in TARGETS}
    changed = sum(targets.values())
    if not changed:
        raise ValueError('The model contains no BasePart or BaseScript descendants.')
    result = [data[:32]]
    inserted = False
    for tag, payload, original in chunks:
        if tag == b'PROP':
            class_id = u32(payload, 0)
            name, offset = read_string(payload, 4)
            if class_id in targets and name == b'AttributesSerialize':
                if class_id in existing or payload[offset] != 1:
                    raise ValueError('Invalid AttributesSerialize property chunk.')
                existing.add(class_id)
                head, values, cursor = payload[:offset + 1], [], offset + 1
                for _ in range(targets[class_id]):
                    value, cursor = read_string(payload, cursor)
                    values.append(packed_string(attributes(value, key)))
                if cursor != len(payload):
                    raise ValueError('Unexpected property data.')
                result.append(chunk(tag, head + b''.join(values)))
                continue
        if tag in (b'PRNT', b'END\x00') and not inserted:
            inserted = True
            for class_id, count in targets.items():
                if class_id not in existing:
                    payload_new = struct.pack('<I', class_id) + packed_string('AttributesSerialize') + b'\x01'
                    payload_new += packed_string(attributes(b'', key)) * count
                    result.append(chunk(b'PROP', payload_new))
        result.append(original)
    return b''.join(result), changed

def stamp(data, key, extension):
    if len(data) > MAX_SIZE:
        raise ValueError('Models must be 16 MiB or smaller.')
    if not key or len(key) > 128:
        raise ValueError('Invalid license length.')
    return binary_stamp(data, key) if extension == '.rbxm' else xml_stamp(data, key)

if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        result, changed = stamp(base64.b64decode(request['data'], validate=True), request['license'], request['extension'])
        print(json.dumps({'data': base64.b64encode(result).decode(), 'changed': changed}))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
