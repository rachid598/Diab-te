package io.github.rachid598.glucovision;

import android.opengl.GLES11Ext;
import android.opengl.GLES20;

import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

/** Dessine la texture camera ARCore en plein ecran. */
final class CameraQuadRenderer {
    private static final float[] QUAD = {
        -1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f
    };
    private static final String VERTEX =
            "attribute vec4 a_Position;\n"
          + "attribute vec2 a_TexCoord;\n"
          + "varying vec2 v_TexCoord;\n"
          + "void main(){ gl_Position=a_Position; v_TexCoord=a_TexCoord; }\n";
    private static final String FRAGMENT =
            "#extension GL_OES_EGL_image_external : require\n"
          + "precision mediump float;\n"
          + "varying vec2 v_TexCoord;\n"
          + "uniform samplerExternalOES u_Texture;\n"
          + "void main(){ gl_FragColor=texture2D(u_Texture,v_TexCoord); }\n";

    private final FloatBuffer vertices = buffer(QUAD);
    private final FloatBuffer textureInput = buffer(QUAD);
    private final FloatBuffer textureOutput = buffer(new float[8]);
    private int textureId = -1;
    private int program;
    private int positionAttribute;
    private int textureAttribute;
    private int textureUniform;
    private boolean coordinatesReady;

    int createTexture() {
        int[] ids = new int[1];
        GLES20.glGenTextures(1, ids, 0);
        textureId = ids[0];
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);

        program = link(compile(GLES20.GL_VERTEX_SHADER, VERTEX),
                compile(GLES20.GL_FRAGMENT_SHADER, FRAGMENT));
        positionAttribute = GLES20.glGetAttribLocation(program, "a_Position");
        textureAttribute = GLES20.glGetAttribLocation(program, "a_TexCoord");
        textureUniform = GLES20.glGetUniformLocation(program, "u_Texture");
        coordinatesReady = false;
        return textureId;
    }

    int textureId() {
        return textureId;
    }

    void draw(Frame frame) {
        if (frame == null || textureId < 0 || program == 0 || frame.getTimestamp() == 0) return;
        if (!coordinatesReady || frame.hasDisplayGeometryChanged()) {
            frame.transformCoordinates2d(
                    Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                    textureInput,
                    Coordinates2d.TEXTURE_NORMALIZED,
                    textureOutput);
            coordinatesReady = true;
        }

        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glDepthMask(false);
        GLES20.glUseProgram(program);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId);
        GLES20.glUniform1i(textureUniform, 0);

        vertices.position(0);
        textureOutput.position(0);
        GLES20.glVertexAttribPointer(positionAttribute, 2, GLES20.GL_FLOAT, false, 0, vertices);
        GLES20.glVertexAttribPointer(textureAttribute, 2, GLES20.GL_FLOAT, false, 0, textureOutput);
        GLES20.glEnableVertexAttribArray(positionAttribute);
        GLES20.glEnableVertexAttribArray(textureAttribute);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(positionAttribute);
        GLES20.glDisableVertexAttribArray(textureAttribute);
        GLES20.glDepthMask(true);
        GLES20.glEnable(GLES20.GL_DEPTH_TEST);
    }

    private static FloatBuffer buffer(float[] values) {
        FloatBuffer result = ByteBuffer.allocateDirect(values.length * 4)
                .order(ByteOrder.nativeOrder()).asFloatBuffer();
        result.put(values).position(0);
        return result;
    }

    private static int compile(int kind, String source) {
        int shader = GLES20.glCreateShader(kind);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        int[] status = new int[1];
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0);
        if (status[0] == 0) {
            String log = GLES20.glGetShaderInfoLog(shader);
            GLES20.glDeleteShader(shader);
            throw new IllegalStateException("Shader camera invalide : " + log);
        }
        return shader;
    }

    private static int link(int vertex, int fragment) {
        int result = GLES20.glCreateProgram();
        GLES20.glAttachShader(result, vertex);
        GLES20.glAttachShader(result, fragment);
        GLES20.glLinkProgram(result);
        int[] status = new int[1];
        GLES20.glGetProgramiv(result, GLES20.GL_LINK_STATUS, status, 0);
        GLES20.glDeleteShader(vertex);
        GLES20.glDeleteShader(fragment);
        if (status[0] == 0) {
            String log = GLES20.glGetProgramInfoLog(result);
            GLES20.glDeleteProgram(result);
            throw new IllegalStateException("Programme camera invalide : " + log);
        }
        return result;
    }
}
