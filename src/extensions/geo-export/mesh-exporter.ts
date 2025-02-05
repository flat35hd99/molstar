/**
 * Copyright (c) 2021 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author Sukolsak Sakshuwong <sukolsak@stanford.edu>
 */

import { GraphicsRenderObject } from '../../mol-gl/render-object';
import { MeshValues } from '../../mol-gl/renderable/mesh';
import { LinesValues } from '../../mol-gl/renderable/lines';
import { PointsValues } from '../../mol-gl/renderable/points';
import { SpheresValues } from '../../mol-gl/renderable/spheres';
import { CylindersValues } from '../../mol-gl/renderable/cylinders';
import { TextureMeshValues } from '../../mol-gl/renderable/texture-mesh';
import { BaseValues, SizeValues } from '../../mol-gl/renderable/schema';
import { TextureImage } from '../../mol-gl/renderable/util';
import { WebGLContext } from '../../mol-gl/webgl/context';
import { getTrilinearlyInterpolated } from '../../mol-geo/geometry/mesh/color-smoothing';
import { Mesh } from '../../mol-geo/geometry/mesh/mesh';
import { MeshBuilder } from '../../mol-geo/geometry/mesh/mesh-builder';
import { addSphere } from '../../mol-geo/geometry/mesh/builder/sphere';
import { addCylinder } from '../../mol-geo/geometry/mesh/builder/cylinder';
import { sizeDataFactor } from '../../mol-geo/geometry/size-data';
import { Vec3 } from '../../mol-math/linear-algebra';
import { RuntimeContext } from '../../mol-task';
import { decodeFloatRGB } from '../../mol-util/float-packing';
import { RenderObjectExporter, RenderObjectExportData } from './render-object-exporter';

const GeoExportName = 'geo-export';

// avoiding namespace lookup improved performance in Chrome (Aug 2020)
const v3fromArray = Vec3.fromArray;

export interface AddMeshInput {
    mesh: {
        vertices: Float32Array
        normals: Float32Array
        indices: Uint32Array | undefined
        groups: Float32Array | Uint8Array
        vertexCount: number
        drawCount: number
    } | undefined
    meshes: Mesh[] | undefined
    values: BaseValues
    isGeoTexture: boolean
    webgl: WebGLContext | undefined
    ctx: RuntimeContext
}

export abstract class MeshExporter<D extends RenderObjectExportData> implements RenderObjectExporter<D> {
    abstract readonly fileExtension: string;

    private static getSizeFromTexture(tSize: TextureImage<Uint8Array>, i: number): number {
        const r = tSize.array[i * 3];
        const g = tSize.array[i * 3 + 1];
        const b = tSize.array[i * 3 + 2];
        return decodeFloatRGB(r, g, b) / sizeDataFactor;
    }

    private static getSize(values: BaseValues & SizeValues, instanceIndex: number, group: number): number {
        const tSize = values.tSize.ref.value;
        let size = 0;
        switch (values.dSizeType.ref.value) {
            case 'uniform':
                size = values.uSize.ref.value;
                break;
            case 'instance':
                size = MeshExporter.getSizeFromTexture(tSize, instanceIndex);
                break;
            case 'group':
                size = MeshExporter.getSizeFromTexture(tSize, group);
                break;
            case 'groupInstance':
                const groupCount = values.uGroupCount.ref.value;
                size = MeshExporter.getSizeFromTexture(tSize, instanceIndex * groupCount + group);
                break;
        }
        return size * values.uSizeFactor.ref.value;
    }

    protected static getGroup(groups: Float32Array | Uint8Array, i: number): number {
        const i4 = i * 4;
        const r = groups[i4];
        const g = groups[i4 + 1];
        const b = groups[i4 + 2];
        if (groups instanceof Float32Array) {
            return decodeFloatRGB(r * 255 + 0.5, g * 255 + 0.5, b * 255 + 0.5);
        }
        return decodeFloatRGB(r, g, b);
    }

    protected static getInterpolatedColors(vertices: Float32Array, vertexCount: number, values: BaseValues, stride: number, colorType: 'volume' | 'volumeInstance', webgl: WebGLContext) {
        const colorGridTransform = values.uColorGridTransform.ref.value;
        const colorGridDim = values.uColorGridDim.ref.value;
        const colorTexDim = values.uColorTexDim.ref.value;
        const aTransform = values.aTransform.ref.value;
        const instanceCount = values.uInstanceCount.ref.value;

        if (!webgl.namedFramebuffers[GeoExportName]) {
            webgl.namedFramebuffers[GeoExportName] = webgl.resources.framebuffer();
        }
        const framebuffer = webgl.namedFramebuffers[GeoExportName];

        const [ width, height ] = colorTexDim;
        const colorGrid = new Uint8Array(width * height * 4);

        framebuffer.bind();
        values.tColorGrid.ref.value.attachFramebuffer(framebuffer, 0);
        webgl.readPixels(0, 0, width, height, colorGrid);

        const interpolated = getTrilinearlyInterpolated({ vertexCount, instanceCount, transformBuffer: aTransform, positionBuffer: vertices, colorType, grid: colorGrid, gridDim: colorGridDim, gridTexDim: colorTexDim, gridTransform: colorGridTransform, vertexStride: stride, colorStride: 4 });
        return interpolated.array;
    }

    protected static getInstance(input: AddMeshInput, instanceIndex: number) {
        const { mesh, meshes } = input;
        if (mesh !== undefined) {
            return mesh;
        } else {
            const mesh = meshes![instanceIndex];
            return {
                vertices: mesh.vertexBuffer.ref.value,
                normals: mesh.normalBuffer.ref.value,
                indices: mesh.indexBuffer.ref.value,
                groups: mesh.groupBuffer.ref.value,
                vertexCount: mesh.vertexCount,
                drawCount: mesh.triangleCount * 3
            };
        }
    }

    protected abstract addMeshWithColors(input: AddMeshInput): void;

    private async addMesh(values: MeshValues, webgl: WebGLContext, ctx: RuntimeContext) {
        const aPosition = values.aPosition.ref.value;
        const aNormal = values.aNormal.ref.value;
        const elements = values.elements.ref.value;
        const aGroup = values.aGroup.ref.value;
        const vertexCount = values.uVertexCount.ref.value;
        const drawCount = values.drawCount.ref.value;

        await this.addMeshWithColors({ mesh: { vertices: aPosition, normals: aNormal, indices: elements, groups: aGroup, vertexCount, drawCount }, meshes: undefined, values, isGeoTexture: false, webgl, ctx });
    }

    private async addLines(values: LinesValues, webgl: WebGLContext, ctx: RuntimeContext) {
        // TODO
    }

    private async addPoints(values: PointsValues, webgl: WebGLContext, ctx: RuntimeContext) {
        // TODO
    }

    private async addSpheres(values: SpheresValues, webgl: WebGLContext, ctx: RuntimeContext) {
        const center = Vec3();

        const aPosition = values.aPosition.ref.value;
        const aGroup = values.aGroup.ref.value;
        const instanceCount = values.instanceCount.ref.value;
        const vertexCount = values.uVertexCount.ref.value;
        const meshes: Mesh[] = [];

        const sphereCount = vertexCount / 4 * instanceCount;
        let detail: number;
        if (sphereCount < 2000) detail = 3;
        else if (sphereCount < 20000) detail = 2;
        else detail = 1;

        for (let instanceIndex = 0; instanceIndex < instanceCount; ++instanceIndex) {
            const state = MeshBuilder.createState(512, 256);

            for (let i = 0; i < vertexCount; i += 4) {
                v3fromArray(center, aPosition, i * 3);

                const group = aGroup[i];
                const radius = MeshExporter.getSize(values, instanceIndex, group);
                state.currentGroup = group;
                addSphere(state, center, radius, detail);
            }

            meshes.push(MeshBuilder.getMesh(state));
        }

        await this.addMeshWithColors({ mesh: undefined, meshes, values, isGeoTexture: false, webgl, ctx });
    }

    private async addCylinders(values: CylindersValues, webgl: WebGLContext, ctx: RuntimeContext) {
        const start = Vec3();
        const end = Vec3();

        const aStart = values.aStart.ref.value;
        const aEnd = values.aEnd.ref.value;
        const aScale = values.aScale.ref.value;
        const aCap = values.aCap.ref.value;
        const aGroup = values.aGroup.ref.value;
        const instanceCount = values.instanceCount.ref.value;
        const vertexCount = values.uVertexCount.ref.value;
        const meshes: Mesh[] = [];

        const cylinderCount = vertexCount / 6 * instanceCount;
        let radialSegments: number;
        if (cylinderCount < 2000) radialSegments = 36;
        else if (cylinderCount < 20000) radialSegments = 24;
        else radialSegments = 12;

        for (let instanceIndex = 0; instanceIndex < instanceCount; ++instanceIndex) {
            const state = MeshBuilder.createState(512, 256);

            for (let i = 0; i < vertexCount; i += 6) {
                v3fromArray(start, aStart, i * 3);
                v3fromArray(end, aEnd, i * 3);

                const group = aGroup[i];
                const radius = MeshExporter.getSize(values, instanceIndex, group) * aScale[i];
                const cap = aCap[i];
                const topCap = cap === 1 || cap === 3;
                const bottomCap = cap >= 2;
                const cylinderProps = { radiusTop: radius, radiusBottom: radius, topCap, bottomCap, radialSegments };
                state.currentGroup = aGroup[i];
                addCylinder(state, start, end, 1, cylinderProps);
            }

            meshes.push(MeshBuilder.getMesh(state));
        }

        await this.addMeshWithColors({ mesh: undefined, meshes, values, isGeoTexture: false, webgl, ctx });
    }

    private async addTextureMesh(values: TextureMeshValues, webgl: WebGLContext, ctx: RuntimeContext) {
        if (!webgl.namedFramebuffers[GeoExportName]) {
            webgl.namedFramebuffers[GeoExportName] = webgl.resources.framebuffer();
        }
        const framebuffer = webgl.namedFramebuffers[GeoExportName];

        const [ width, height ] = values.uGeoTexDim.ref.value;
        const vertices = new Float32Array(width * height * 4);
        const normals = new Float32Array(width * height * 4);
        const groups = webgl.isWebGL2 ? new Uint8Array(width * height * 4) : new Float32Array(width * height * 4);

        framebuffer.bind();
        values.tPosition.ref.value.attachFramebuffer(framebuffer, 0);
        webgl.readPixels(0, 0, width, height, vertices);
        values.tNormal.ref.value.attachFramebuffer(framebuffer, 0);
        webgl.readPixels(0, 0, width, height, normals);
        values.tGroup.ref.value.attachFramebuffer(framebuffer, 0);
        webgl.readPixels(0, 0, width, height, groups);

        const vertexCount = values.uVertexCount.ref.value;
        const drawCount = values.drawCount.ref.value;

        await this.addMeshWithColors({ mesh: { vertices, normals, indices: undefined, groups, vertexCount, drawCount }, meshes: undefined, values, isGeoTexture: true, webgl, ctx });
    }

    add(renderObject: GraphicsRenderObject, webgl: WebGLContext, ctx: RuntimeContext) {
        if (!renderObject.state.visible) return;

        switch (renderObject.type) {
            case 'mesh':
                return this.addMesh(renderObject.values as MeshValues, webgl, ctx);
            case 'lines':
                return this.addLines(renderObject.values as LinesValues, webgl, ctx);
            case 'points':
                return this.addPoints(renderObject.values as PointsValues, webgl, ctx);
            case 'spheres':
                return this.addSpheres(renderObject.values as SpheresValues, webgl, ctx);
            case 'cylinders':
                return this.addCylinders(renderObject.values as CylindersValues, webgl, ctx);
            case 'texture-mesh':
                return this.addTextureMesh(renderObject.values as TextureMeshValues, webgl, ctx);
        }
    }

    abstract getData(): D;

    abstract getBlob(ctx: RuntimeContext): Promise<Blob>;
}