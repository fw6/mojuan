plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.fw6.mojuan.render"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // 覆写 Plugin.onDestroy(AppCompatActivity)：AppCompatActivity 在插件模块的编译路径上
    implementation("androidx.appcompat:appcompat:1.7.1")
    // app.tauri.*（Plugin / Invoke / 注解）：由 tauri 的 android 库提供
    implementation(project(":tauri-android"))
}
