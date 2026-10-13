plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.fw6.mojuan.systembars"
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
    // WindowCompat / WindowInsetsControllerCompat / ViewCompat：系统栏的显隐与图标明暗
    // 走 compat 层（平台的 WindowInsetsController 要 API 30，app 的 minSdk 是 24）
    implementation("androidx.core:core-ktx:1.13.1")
    // app.tauri.*（Plugin / Invoke / 注解）：由 tauri 的 android 库提供
    implementation(project(":tauri-android"))
}
