/*M///////////////////////////////////////////////////////////////////////////////////////
//
//  IMPORTANT: READ BEFORE DOWNLOADING, COPYING, INSTALLING OR USING.
//
//  By downloading, copying, installing or using the software you agree to this license.
//  If you do not agree to this license, do not download, install,
//  copy or use the software.
//
//
//                           License Agreement
//                For Open Source Computer Vision Library
//
// Copyright (C) 2013, OpenCV Foundation, all rights reserved.
// Third party copyrights are property of their respective owners.
//
// Redistribution and use in source and binary forms, with or without modification,
// are permitted provided that the following conditions are met:
//
//   * Redistribution's of source code must retain the above copyright notice,
//     this list of conditions and the following disclaimer.
//
//   * Redistribution's in binary form must reproduce the above copyright notice,
//     this list of conditions and the following disclaimer in the documentation
//     and/or other materials provided with the distribution.
//
//   * The name of the copyright holders may not be used to endorse or promote products
//     derived from this software without specific prior written permission.
//
// This software is provided by the copyright holders and contributors "as is" and
// any express or implied warranties, including, but not limited to, the implied
// warranties of merchantability and fitness for a particular purpose are disclaimed.
// In no event shall the Intel Corporation or contributors be liable for any direct,
// indirect, incidental, special, exemplary, or consequential damages
// (including, but not limited to, procurement of substitute goods or services;
// loss of use, data, or profits; or business interruption) however caused
// and on any theory of liability, whether in contract, strict liability,
// or tort (including negligence or otherwise) arising in any way out of
// the use of this software, even if advised of the possibility of such damage.
//
//M*/

/*M///////////////////////////////////////////////////////////////////////////////////////
// Author: Sajjad Taheri, University of California, Irvine. sajjadt[at]uci[dot]edu
//
//                             LICENSE AGREEMENT
// Copyright (c) 2015 The Regents of the University of California (Regents)
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// 1. Redistributions of source code must retain the above copyright
//    notice, this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright
//    notice, this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
// 3. Neither the name of the University nor the
//    names of its contributors may be used to endorse or promote products
//    derived from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS ''AS IS'' AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//M*/

#include <emscripten/bind.h>

#include "opencv2/core.hpp"
#include "opencv2/core/async.hpp"
#include "opencv2/core/base.hpp"
#include "opencv2/core/bindings_utils.hpp"
#include "opencv2/core/check.hpp"
#include "opencv2/core/mat.hpp"
#include "opencv2/core/optim.hpp"
#include "opencv2/core/ovx.hpp"
#include "opencv2/core/parallel/parallel_backend.hpp"
#include "opencv2/core/persistence.hpp"
#include "opencv2/core/quaternion.hpp"
#include "opencv2/core/types.hpp"
#include "opencv2/core/utility.hpp"
#include "opencv2/core/utils/logger.defines.hpp"
#include "opencv2/core/utils/logger.hpp"
#include "opencv2/imgproc.hpp"
#include "opencv2/imgproc/bindings.hpp"
#include "opencv2/imgproc/segmentation.hpp"
#include "opencv2/photo.hpp"
#include "opencv2/photo/cuda.hpp"
#include "opencv2/dnn/dict.hpp"
#include "opencv2/dnn/dnn.hpp"
#include "opencv2/dnn/utils/inference_engine.hpp"
#include "opencv2/features2d.hpp"
#include "opencv2/calib3d.hpp"
#include "opencv2/objdetect.hpp"
#include "opencv2/objdetect/aruco_board.hpp"
#include "opencv2/objdetect/aruco_detector.hpp"
#include "opencv2/objdetect/aruco_dictionary.hpp"
#include "opencv2/objdetect/barcode.hpp"
#include "opencv2/objdetect/charuco_detector.hpp"
#include "opencv2/objdetect/face.hpp"
#include "opencv2/objdetect/graphical_code_detector.hpp"
#include "opencv2/video/background_segm.hpp"
#include "opencv2/video/detail/tracking.detail.hpp"
#include "opencv2/video/tracking.hpp"
#include "../../../modules/core/src/parallel_impl.hpp"

#ifdef TEST_WASM_INTRIN
#include "../../../modules/core/include/opencv2/core/hal/intrin.hpp"
#include "../../../modules/core/include/opencv2/core/utils/trace.hpp"
#include "../../../modules/ts/include/opencv2/ts/ts_gtest.h"
namespace cv {
namespace hal {
#include "../../../modules/core/test/test_intrin_utils.hpp"
}
}
#endif

using namespace emscripten;
using namespace cv;

using namespace cv::segmentation;  // FIXIT

#ifdef HAVE_OPENCV_OBJDETECT
using namespace cv::aruco;
typedef aruco::DetectorParameters aruco_DetectorParameters;
typedef QRCodeDetectorAruco::Params QRCodeDetectorAruco_Params;
#endif

#ifdef HAVE_OPENCV_DNN
using namespace cv::dnn;
#endif

#ifdef HAVE_OPENCV_FEATURES2D
typedef SimpleBlobDetector::Params SimpleBlobDetector_Params;
#endif

#ifdef HAVE_OPENCV_VIDEO
typedef TrackerMIL::Params TrackerMIL_Params;
#endif

#ifdef HAVE_OPENCV_XIMGPROC
typedef ximgproc::EdgeDrawing::Params EdgeDrawing_Params;
#endif

// HACK: JS generator ommits namespace for parameter types for some reason. Added typedef to handle std::string correctly
typedef std::string string;

namespace binding_utils
{
    template<typename classT, typename enumT>
    static inline typename std::underlying_type<enumT>::type classT::* underlying_ptr(enumT classT::* enum_ptr)
    {
        return reinterpret_cast<typename std::underlying_type<enumT>::type classT::*>(enum_ptr);
    }

    template<typename T>
    emscripten::val matData(const cv::Mat& mat)
    {
        return emscripten::val(emscripten::memory_view<T>((mat.total()*mat.elemSize())/sizeof(T),
                               (T*)mat.data));
    }

    template<typename T>
    emscripten::val matPtr(const cv::Mat& mat, int i)
    {
        return emscripten::val(emscripten::memory_view<T>(mat.step1(0), mat.ptr<T>(i)));
    }

    template<typename T>
    emscripten::val matPtr(const cv::Mat& mat, int i, int j)
    {
        return emscripten::val(emscripten::memory_view<T>(mat.step1(1), mat.ptr<T>(i,j)));
    }

    cv::Mat* createMat(int rows, int cols, int type, intptr_t data, size_t step)
    {
        return new cv::Mat(rows, cols, type, reinterpret_cast<void*>(data), step);
    }

    static emscripten::val getMatSize(const cv::Mat& mat)
    {
        emscripten::val size = emscripten::val::array();
        for (int i = 0; i < mat.dims; i++) {
            size.call<void>("push", mat.size[i]);
        }
        return size;
    }

    static emscripten::val getMatStep(const cv::Mat& mat)
    {
        emscripten::val step = emscripten::val::array();
        for (int i = 0; i < mat.dims; i++) {
            step.call<void>("push", mat.step[i]);
        }
        return step;
    }

    static Mat matEye(int rows, int cols, int type)
    {
        return Mat(cv::Mat::eye(rows, cols, type));
    }

    static Mat matEye(Size size, int type)
    {
        return Mat(cv::Mat::eye(size, type));
    }

    void convertTo(const Mat& obj, Mat& m, int rtype, double alpha, double beta)
    {
        obj.convertTo(m, rtype, alpha, beta);
    }

    void convertTo(const Mat& obj, Mat& m, int rtype)
    {
        obj.convertTo(m, rtype);
    }

    void convertTo(const Mat& obj, Mat& m, int rtype, double alpha)
    {
        obj.convertTo(m, rtype, alpha);
    }

    Size matSize(const cv::Mat& mat)
    {
        return mat.size();
    }

    cv::Mat matZeros(int arg0, int arg1, int arg2)
    {
        return cv::Mat::zeros(arg0, arg1, arg2);
    }

    cv::Mat matZeros(cv::Size arg0, int arg1)
    {
        return cv::Mat::zeros(arg0,arg1);
    }

    cv::Mat matOnes(int arg0, int arg1, int arg2)
    {
        return cv::Mat::ones(arg0, arg1, arg2);
    }

    cv::Mat matOnes(cv::Size arg0, int arg1)
    {
        return cv::Mat::ones(arg0, arg1);
    }

    double matDot(const cv::Mat& obj, const Mat& mat)
    {
        return  obj.dot(mat);
    }

    Mat matMul(const cv::Mat& obj, const Mat& mat, double scale)
    {
        return  Mat(obj.mul(mat, scale));
    }

    Mat matT(const cv::Mat& obj)
    {
        return  Mat(obj.t());
    }

    Mat matInv(const cv::Mat& obj, int type)
    {
        return  Mat(obj.inv(type));
    }

    void matCopyTo(const cv::Mat& obj, cv::Mat& mat)
    {
        return obj.copyTo(mat);
    }

    void matCopyTo(const cv::Mat& obj, cv::Mat& mat, const cv::Mat& mask)
    {
        return obj.copyTo(mat, mask);
    }

    Mat matDiag(const cv::Mat& obj, int d)
    {
        return obj.diag(d);
    }

    Mat matDiag(const cv::Mat& obj)
    {
        return obj.diag();
    }

    void matSetTo(cv::Mat& obj, const cv::Scalar& s)
    {
        obj.setTo(s);
    }

    void matSetTo(cv::Mat& obj, const cv::Scalar& s, const cv::Mat& mask)
    {
        obj.setTo(s, mask);
    }

    emscripten::val rotatedRectPoints(const cv::RotatedRect& obj)
    {
        cv::Point2f points[4];
        obj.points(points);
        emscripten::val pointsArray = emscripten::val::array();
        for (int i = 0; i < 4; i++) {
            pointsArray.call<void>("push", points[i]);
        }
        return pointsArray;
    }

    Rect rotatedRectBoundingRect(const cv::RotatedRect& obj)
    {
        return obj.boundingRect();
    }

    Rect2f rotatedRectBoundingRect2f(const cv::RotatedRect& obj)
    {
        return obj.boundingRect2f();
    }

    int cvMatDepth(int flags)
    {
        return CV_MAT_DEPTH(flags);
    }

    class MinMaxLoc
    {
    public:
        double minVal;
        double maxVal;
        Point minLoc;
        Point maxLoc;
    };

    MinMaxLoc minMaxLoc(const cv::Mat& src, const cv::Mat& mask)
    {
        MinMaxLoc result;
        cv::minMaxLoc(src, &result.minVal, &result.maxVal, &result.minLoc, &result.maxLoc, mask);
        return result;
    }

    MinMaxLoc minMaxLoc_1(const cv::Mat& src)
    {
        MinMaxLoc result;
        cv::minMaxLoc(src, &result.minVal, &result.maxVal, &result.minLoc, &result.maxLoc);
        return result;
    }

    class Circle
    {
    public:
        Point2f center;
        float radius;
    };

#ifdef HAVE_OPENCV_IMGPROC
    Circle minEnclosingCircle(const cv::Mat& points)
    {
        Circle circle;
        cv::minEnclosingCircle(points, circle.center, circle.radius);
        return circle;
    }

    int floodFill_withRect_helper(cv::Mat& arg1, cv::Mat& arg2, Point arg3, Scalar arg4, emscripten::val arg5, Scalar arg6 = Scalar(), Scalar arg7 = Scalar(), int arg8 = 4)
    {
        cv::Rect rect;

        int rc = cv::floodFill(arg1, arg2, arg3, arg4, &rect, arg6, arg7, arg8);

        arg5.set("x", emscripten::val(rect.x));
        arg5.set("y", emscripten::val(rect.y));
        arg5.set("width", emscripten::val(rect.width));
        arg5.set("height", emscripten::val(rect.height));

        return rc;
    }

    int floodFill_wrapper(cv::Mat& arg1, cv::Mat& arg2, Point arg3, Scalar arg4, emscripten::val arg5, Scalar arg6, Scalar arg7, int arg8) {
        return floodFill_withRect_helper(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }

    int floodFill_wrapper_1(cv::Mat& arg1, cv::Mat& arg2, Point arg3, Scalar arg4, emscripten::val arg5, Scalar arg6, Scalar arg7) {
        return floodFill_withRect_helper(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }

    int floodFill_wrapper_2(cv::Mat& arg1, cv::Mat& arg2, Point arg3, Scalar arg4, emscripten::val arg5, Scalar arg6) {
        return floodFill_withRect_helper(arg1, arg2, arg3, arg4, arg5, arg6);
    }

    int floodFill_wrapper_3(cv::Mat& arg1, cv::Mat& arg2, Point arg3, Scalar arg4, emscripten::val arg5) {
        return floodFill_withRect_helper(arg1, arg2, arg3, arg4, arg5);
    }

    int floodFill_wrapper_4(cv::Mat& arg1, cv::Mat& arg2, Point arg3, Scalar arg4) {
        return cv::floodFill(arg1, arg2, arg3, arg4);
    }
#endif

#ifdef HAVE_OPENCV_VIDEO
    emscripten::val CamShiftWrapper(const cv::Mat& arg1, Rect& arg2, TermCriteria arg3)
    {
        RotatedRect rotatedRect = cv::CamShift(arg1, arg2, arg3);
        emscripten::val result = emscripten::val::array();
        result.call<void>("push", rotatedRect);
        result.call<void>("push", arg2);
        return result;
    }

    emscripten::val meanShiftWrapper(const cv::Mat& arg1, Rect& arg2, TermCriteria arg3)
    {
        int n = cv::meanShift(arg1, arg2, arg3);
        emscripten::val result = emscripten::val::array();
        result.call<void>("push", n);
        result.call<void>("push", arg2);
        return result;
    }

    void Tracker_init_wrapper(cv::Tracker& arg0, const cv::Mat& arg1, const Rect& arg2)
    {
        return arg0.init(arg1, arg2);
    }

    emscripten::val Tracker_update_wrapper(cv::Tracker& arg0, const cv::Mat& arg1)
    {
        Rect rect;
        bool update = arg0.update(arg1, rect);

        emscripten::val result = emscripten::val::array();
        result.call<void>("push", update);
        result.call<void>("push", rect);
        return result;
    }
#endif  // HAVE_OPENCV_VIDEO

    std::string getExceptionMsg(const cv::Exception& e) {
        return e.msg;
    }

    void setExceptionMsg(cv::Exception& e, std::string msg) {
        e.msg = msg;
        return;
    }

    cv::Exception exceptionFromPtr(intptr_t ptr) {
        return *reinterpret_cast<cv::Exception*>(ptr);
    }

    std::string getBuildInformation() {
        return cv::getBuildInformation();
    }

#ifdef TEST_WASM_INTRIN
    void test_hal_intrin_uint8() {
        cv::hal::test_hal_intrin_uint8();
    }
    void test_hal_intrin_int8() {
        cv::hal::test_hal_intrin_int8();
    }
    void test_hal_intrin_uint16() {
        cv::hal::test_hal_intrin_uint16();
    }
    void test_hal_intrin_int16() {
        cv::hal::test_hal_intrin_int16();
    }
    void test_hal_intrin_uint32() {
        cv::hal::test_hal_intrin_uint32();
    }
    void test_hal_intrin_int32() {
        cv::hal::test_hal_intrin_int32();
    }
    void test_hal_intrin_uint64() {
        cv::hal::test_hal_intrin_uint64();
    }
    void test_hal_intrin_int64() {
        cv::hal::test_hal_intrin_int64();
    }
    void test_hal_intrin_float32() {
        cv::hal::test_hal_intrin_float32();
    }
    void test_hal_intrin_float64() {
        cv::hal::test_hal_intrin_float64();
    }
    void test_hal_intrin_all() {
        cv::hal::test_hal_intrin_uint8();
        cv::hal::test_hal_intrin_int8();
        cv::hal::test_hal_intrin_uint16();
        cv::hal::test_hal_intrin_int16();
        cv::hal::test_hal_intrin_uint32();
        cv::hal::test_hal_intrin_int32();
        cv::hal::test_hal_intrin_uint64();
        cv::hal::test_hal_intrin_int64();
        cv::hal::test_hal_intrin_float32();
        cv::hal::test_hal_intrin_float64();
    }
#endif
}

EMSCRIPTEN_BINDINGS(binding_utils)
{
    register_vector<int>("IntVector");
    register_vector<char>("CharVector");
    register_vector<float>("FloatVector");
    register_vector<double>("DoubleVector");
    register_vector<std::string>("StringVector");
    register_vector<cv::Point>("PointVector");
    register_vector<cv::Point2f>("Point2fVector");
    register_vector<cv::Point3_<float>>("Point3fVector");
    register_vector<cv::Mat>("MatVector");
    register_vector<cv::Rect>("RectVector");
    register_vector<cv::KeyPoint>("KeyPointVector");
    register_vector<cv::DMatch>("DMatchVector");
    register_vector<std::vector<char>>("CharVectorVector");
    register_vector<std::vector<cv::DMatch>>("DMatchVectorVector");
    register_vector<std::vector<cv::KeyPoint>>("KeyPointVectorVector");
    register_vector<std::vector<cv::Point>>("PointVectorVector");


    emscripten::class_<cv::Mat>("Mat")
        .constructor<>()
        .constructor<const Mat&>()
        .constructor<Size, int>()
        .constructor<int, int, int>()
        .constructor<int, int, int, const Scalar&>()
        .constructor(&binding_utils::createMat, allow_raw_pointers())

        .class_function("eye", select_overload<Mat(Size, int)>(&binding_utils::matEye))
        .class_function("eye", select_overload<Mat(int, int, int)>(&binding_utils::matEye))
        .class_function("ones", select_overload<Mat(Size, int)>(&binding_utils::matOnes))
        .class_function("ones", select_overload<Mat(int, int, int)>(&binding_utils::matOnes))
        .class_function("zeros", select_overload<Mat(Size, int)>(&binding_utils::matZeros))
        .class_function("zeros", select_overload<Mat(int, int, int)>(&binding_utils::matZeros))

        .property("rows", &cv::Mat::rows)
        .property("cols", &cv::Mat::cols)
        .property("matSize", &binding_utils::getMatSize)
        .property("step", &binding_utils::getMatStep)
        .property("data", &binding_utils::matData<unsigned char>)
        .property("data8S", &binding_utils::matData<char>)
        .property("data16U", &binding_utils::matData<unsigned short>)
        .property("data16S", &binding_utils::matData<short>)
        .property("data32S", &binding_utils::matData<int>)
        .property("data32F", &binding_utils::matData<float>)
        .property("data64F", &binding_utils::matData<double>)

        .function("elemSize", select_overload<size_t()const>(&cv::Mat::elemSize))
        .function("elemSize1", select_overload<size_t()const>(&cv::Mat::elemSize1))
        .function("channels", select_overload<int()const>(&cv::Mat::channels))
        .function("convertTo", select_overload<void(const Mat&, Mat&, int, double, double)>(&binding_utils::convertTo))
        .function("convertTo", select_overload<void(const Mat&, Mat&, int)>(&binding_utils::convertTo))
        .function("convertTo", select_overload<void(const Mat&, Mat&, int, double)>(&binding_utils::convertTo))
        .function("total", select_overload<size_t()const>(&cv::Mat::total))
        .function("row", select_overload<Mat(int)const>(&cv::Mat::row))
        .function("create", select_overload<void(int, int, int)>(&cv::Mat::create))
        .function("create", select_overload<void(Size, int)>(&cv::Mat::create))
        .function("rowRange", select_overload<Mat(int, int)const>(&cv::Mat::rowRange))
        .function("rowRange", select_overload<Mat(const Range&)const>(&cv::Mat::rowRange))
        .function("copyTo", select_overload<void(const Mat&, Mat&)>(&binding_utils::matCopyTo))
        .function("copyTo", select_overload<void(const Mat&, Mat&, const Mat&)>(&binding_utils::matCopyTo))
        .function("type", select_overload<int()const>(&cv::Mat::type))
        .function("empty", select_overload<bool()const>(&cv::Mat::empty))
        .function("colRange", select_overload<Mat(int, int)const>(&cv::Mat::colRange))
        .function("colRange", select_overload<Mat(const Range&)const>(&cv::Mat::colRange))
        .function("step1", select_overload<size_t(int)const>(&cv::Mat::step1))
        .function("mat_clone", select_overload<Mat()const>(&cv::Mat::clone))
        .function("depth", select_overload<int()const>(&cv::Mat::depth))
        .function("col", select_overload<Mat(int)const>(&cv::Mat::col))
        .function("dot", select_overload<double(const Mat&, const Mat&)>(&binding_utils::matDot))
        .function("mul", select_overload<Mat(const Mat&, const Mat&, double)>(&binding_utils::matMul))
        .function("inv", select_overload<Mat(const Mat&, int)>(&binding_utils::matInv))
        .function("t", select_overload<Mat(const Mat&)>(&binding_utils::matT))
        .function("roi", select_overload<Mat(const Rect&)const>(&cv::Mat::operator()))
        .function("diag", select_overload<Mat(const Mat&, int)>(&binding_utils::matDiag))
        .function("diag", select_overload<Mat(const Mat&)>(&binding_utils::matDiag))
        .function("isContinuous", select_overload<bool()const>(&cv::Mat::isContinuous))
        .function("setTo", select_overload<void(Mat&, const Scalar&)>(&binding_utils::matSetTo))
        .function("setTo", select_overload<void(Mat&, const Scalar&, const Mat&)>(&binding_utils::matSetTo))
        .function("size", select_overload<Size(const Mat&)>(&binding_utils::matSize))

        .function("ptr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<unsigned char>))
        .function("ptr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<unsigned char>))
        .function("ucharPtr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<unsigned char>))
        .function("ucharPtr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<unsigned char>))
        .function("charPtr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<char>))
        .function("charPtr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<char>))
        .function("shortPtr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<short>))
        .function("shortPtr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<short>))
        .function("ushortPtr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<unsigned short>))
        .function("ushortPtr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<unsigned short>))
        .function("intPtr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<int>))
        .function("intPtr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<int>))
        .function("floatPtr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<float>))
        .function("floatPtr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<float>))
        .function("doublePtr", select_overload<val(const Mat&, int)>(&binding_utils::matPtr<double>))
        .function("doublePtr", select_overload<val(const Mat&, int, int)>(&binding_utils::matPtr<double>))

        .function("charAt", select_overload<char&(int)>(&cv::Mat::at<char>))
        .function("charAt", select_overload<char&(int, int)>(&cv::Mat::at<char>))
        .function("charAt", select_overload<char&(int, int, int)>(&cv::Mat::at<char>))
        .function("ucharAt", select_overload<unsigned char&(int)>(&cv::Mat::at<unsigned char>))
        .function("ucharAt", select_overload<unsigned char&(int, int)>(&cv::Mat::at<unsigned char>))
        .function("ucharAt", select_overload<unsigned char&(int, int, int)>(&cv::Mat::at<unsigned char>))
        .function("shortAt", select_overload<short&(int)>(&cv::Mat::at<short>))
        .function("shortAt", select_overload<short&(int, int)>(&cv::Mat::at<short>))
        .function("shortAt", select_overload<short&(int, int, int)>(&cv::Mat::at<short>))
        .function("ushortAt", select_overload<unsigned short&(int)>(&cv::Mat::at<unsigned short>))
        .function("ushortAt", select_overload<unsigned short&(int, int)>(&cv::Mat::at<unsigned short>))
        .function("ushortAt", select_overload<unsigned short&(int, int, int)>(&cv::Mat::at<unsigned short>))
        .function("intAt", select_overload<int&(int)>(&cv::Mat::at<int>) )
        .function("intAt", select_overload<int&(int, int)>(&cv::Mat::at<int>) )
        .function("intAt", select_overload<int&(int, int, int)>(&cv::Mat::at<int>) )
        .function("floatAt", select_overload<float&(int)>(&cv::Mat::at<float>))
        .function("floatAt", select_overload<float&(int, int)>(&cv::Mat::at<float>))
        .function("floatAt", select_overload<float&(int, int, int)>(&cv::Mat::at<float>))
        .function("doubleAt", select_overload<double&(int, int, int)>(&cv::Mat::at<double>))
        .function("doubleAt", select_overload<double&(int)>(&cv::Mat::at<double>))
        .function("doubleAt", select_overload<double&(int, int)>(&cv::Mat::at<double>));

    emscripten::value_object<cv::Range>("Range")
        .field("start", &cv::Range::start)
        .field("end", &cv::Range::end);

    emscripten::value_object<cv::TermCriteria>("TermCriteria")
        .field("type", &cv::TermCriteria::type)
        .field("maxCount", &cv::TermCriteria::maxCount)
        .field("epsilon", &cv::TermCriteria::epsilon);

#define EMSCRIPTEN_CV_SIZE(type) \
    emscripten::value_object<type>(#type) \
        .field("width", &type::width) \
        .field("height", &type::height);

    EMSCRIPTEN_CV_SIZE(Size)
    EMSCRIPTEN_CV_SIZE(Size2f)

#define EMSCRIPTEN_CV_POINT(type) \
    emscripten::value_object<type>(#type) \
        .field("x", &type::x) \
        .field("y", &type::y); \

    EMSCRIPTEN_CV_POINT(Point)
    EMSCRIPTEN_CV_POINT(Point2f)
    EMSCRIPTEN_CV_POINT(Point3f)

#define EMSCRIPTEN_CV_RECT(type, name) \
    emscripten::value_object<cv::Rect_<type>> (name) \
        .field("x", &cv::Rect_<type>::x) \
        .field("y", &cv::Rect_<type>::y) \
        .field("width", &cv::Rect_<type>::width) \
        .field("height", &cv::Rect_<type>::height);

    EMSCRIPTEN_CV_RECT(int, "Rect")
    EMSCRIPTEN_CV_RECT(float, "Rect2f")
    EMSCRIPTEN_CV_RECT(double, "Rect2d")

    emscripten::value_object<cv::RotatedRect>("RotatedRect")
        .field("center", &cv::RotatedRect::center)
        .field("size", &cv::RotatedRect::size)
        .field("angle", &cv::RotatedRect::angle);

    emscripten::value_object<cv::KeyPoint>("KeyPoint")
        .field("angle", &cv::KeyPoint::angle)
        .field("class_id", &cv::KeyPoint::class_id)
        .field("octave", &cv::KeyPoint::octave)
        .field("pt", &cv::KeyPoint::pt)
        .field("response", &cv::KeyPoint::response)
        .field("size", &cv::KeyPoint::size);

    emscripten::value_object<cv::DMatch>("DMatch")
        .field("queryIdx", &cv::DMatch::queryIdx)
        .field("trainIdx", &cv::DMatch::trainIdx)
        .field("imgIdx", &cv::DMatch::imgIdx)
        .field("distance", &cv::DMatch::distance);

    emscripten::value_array<cv::Scalar_<double>> ("Scalar")
        .element(emscripten::index<0>())
        .element(emscripten::index<1>())
        .element(emscripten::index<2>())
        .element(emscripten::index<3>());

    emscripten::value_object<binding_utils::MinMaxLoc>("MinMaxLoc")
        .field("minVal", &binding_utils::MinMaxLoc::minVal)
        .field("maxVal", &binding_utils::MinMaxLoc::maxVal)
        .field("minLoc", &binding_utils::MinMaxLoc::minLoc)
        .field("maxLoc", &binding_utils::MinMaxLoc::maxLoc);

    emscripten::value_object<cv::Exception>("Exception")
        .field("code", &cv::Exception::code)
        .field("msg", &binding_utils::getExceptionMsg, &binding_utils::setExceptionMsg);

    emscripten::value_object<binding_utils::Circle>("Circle")
        .field("center", &binding_utils::Circle::center)
        .field("radius", &binding_utils::Circle::radius);

    function("boxPoints", select_overload<emscripten::val(const cv::RotatedRect&)>(&binding_utils::rotatedRectPoints));
    function("rotatedRectPoints", select_overload<emscripten::val(const cv::RotatedRect&)>(&binding_utils::rotatedRectPoints));
    function("rotatedRectBoundingRect", select_overload<Rect(const cv::RotatedRect&)>(&binding_utils::rotatedRectBoundingRect));
    function("rotatedRectBoundingRect2f", select_overload<Rect2f(const cv::RotatedRect&)>(&binding_utils::rotatedRectBoundingRect2f));
    function("exceptionFromPtr", &binding_utils::exceptionFromPtr, allow_raw_pointers());
    function("minMaxLoc", select_overload<binding_utils::MinMaxLoc(const cv::Mat&, const cv::Mat&)>(&binding_utils::minMaxLoc));
    function("minMaxLoc", select_overload<binding_utils::MinMaxLoc(const cv::Mat&)>(&binding_utils::minMaxLoc_1));
    function("CV_MAT_DEPTH", &binding_utils::cvMatDepth);
    function("getBuildInformation", &binding_utils::getBuildInformation);

#ifdef HAVE_OPENCV_IMGPROC
    emscripten::value_object<cv::Moments >("Moments")
        .field("m00", &cv::Moments::m00)
        .field("m10", &cv::Moments::m10)
        .field("m01", &cv::Moments::m01)
        .field("m20", &cv::Moments::m20)
        .field("m11", &cv::Moments::m11)
        .field("m02", &cv::Moments::m02)
        .field("m30", &cv::Moments::m30)
        .field("m21", &cv::Moments::m21)
        .field("m12", &cv::Moments::m12)
        .field("m03", &cv::Moments::m03)
        .field("mu20", &cv::Moments::mu20)
        .field("mu11", &cv::Moments::mu11)
        .field("mu02", &cv::Moments::mu02)
        .field("mu30", &cv::Moments::mu30)
        .field("mu21", &cv::Moments::mu21)
        .field("mu12", &cv::Moments::mu12)
        .field("mu03", &cv::Moments::mu03)
        .field("nu20", &cv::Moments::nu20)
        .field("nu11", &cv::Moments::nu11)
        .field("nu02", &cv::Moments::nu02)
        .field("nu30", &cv::Moments::nu30)
        .field("nu21", &cv::Moments::nu21)
        .field("nu12", &cv::Moments::nu12)
        .field("nu03", &cv::Moments::nu03);

    function("minEnclosingCircle", select_overload<binding_utils::Circle(const cv::Mat&)>(&binding_utils::minEnclosingCircle));
    function("floodFill", select_overload<int(cv::Mat&, cv::Mat&, Point, Scalar, emscripten::val, Scalar, Scalar, int)>(&binding_utils::floodFill_wrapper));
    function("floodFill", select_overload<int(cv::Mat&, cv::Mat&, Point, Scalar, emscripten::val, Scalar, Scalar)>(&binding_utils::floodFill_wrapper_1));
    function("floodFill", select_overload<int(cv::Mat&, cv::Mat&, Point, Scalar, emscripten::val, Scalar)>(&binding_utils::floodFill_wrapper_2));
    function("floodFill", select_overload<int(cv::Mat&, cv::Mat&, Point, Scalar, emscripten::val)>(&binding_utils::floodFill_wrapper_3));
    function("floodFill", select_overload<int(cv::Mat&, cv::Mat&, Point, Scalar)>(&binding_utils::floodFill_wrapper_4));
    function("morphologyDefaultBorderValue", &cv::morphologyDefaultBorderValue);
#endif

#ifdef HAVE_OPENCV_VIDEO
    function("CamShift", select_overload<emscripten::val(const cv::Mat&, Rect&, TermCriteria)>(&binding_utils::CamShiftWrapper));
    function("meanShift", select_overload<emscripten::val(const cv::Mat&, Rect&, TermCriteria)>(&binding_utils::meanShiftWrapper));

    emscripten::class_<cv::Tracker >("Tracker")
        .function("init", select_overload<void(cv::Tracker&,const cv::Mat&,const Rect&)>(&binding_utils::Tracker_init_wrapper), pure_virtual())
        .function("update", select_overload<emscripten::val(cv::Tracker&,const cv::Mat&)>(&binding_utils::Tracker_update_wrapper), pure_virtual());
#endif

#ifdef HAVE_PTHREADS_PF
    function("parallel_pthreads_set_threads_num", &cv::parallel_pthreads_set_threads_num);
    function("parallel_pthreads_get_threads_num", &cv::parallel_pthreads_get_threads_num);
#endif

#ifdef TEST_WASM_INTRIN
    function("test_hal_intrin_uint8", &binding_utils::test_hal_intrin_uint8);
    function("test_hal_intrin_int8", &binding_utils::test_hal_intrin_int8);
    function("test_hal_intrin_uint16", &binding_utils::test_hal_intrin_uint16);
    function("test_hal_intrin_int16", &binding_utils::test_hal_intrin_int16);
    function("test_hal_intrin_uint32", &binding_utils::test_hal_intrin_uint32);
    function("test_hal_intrin_int32", &binding_utils::test_hal_intrin_int32);
    function("test_hal_intrin_uint64", &binding_utils::test_hal_intrin_uint64);
    function("test_hal_intrin_int64", &binding_utils::test_hal_intrin_int64);
    function("test_hal_intrin_float32", &binding_utils::test_hal_intrin_float32);
    function("test_hal_intrin_float64", &binding_utils::test_hal_intrin_float64);
    function("test_hal_intrin_all", &binding_utils::test_hal_intrin_all);
#endif

    constant("CV_8UC1", CV_8UC1);
    constant("CV_8UC2", CV_8UC2);
    constant("CV_8UC3", CV_8UC3);
    constant("CV_8UC4", CV_8UC4);

    constant("CV_8SC1", CV_8SC1);
    constant("CV_8SC2", CV_8SC2);
    constant("CV_8SC3", CV_8SC3);
    constant("CV_8SC4", CV_8SC4);

    constant("CV_16UC1", CV_16UC1);
    constant("CV_16UC2", CV_16UC2);
    constant("CV_16UC3", CV_16UC3);
    constant("CV_16UC4", CV_16UC4);

    constant("CV_16SC1", CV_16SC1);
    constant("CV_16SC2", CV_16SC2);
    constant("CV_16SC3", CV_16SC3);
    constant("CV_16SC4", CV_16SC4);

    constant("CV_32SC1", CV_32SC1);
    constant("CV_32SC2", CV_32SC2);
    constant("CV_32SC3", CV_32SC3);
    constant("CV_32SC4", CV_32SC4);

    constant("CV_32FC1", CV_32FC1);
    constant("CV_32FC2", CV_32FC2);
    constant("CV_32FC3", CV_32FC3);
    constant("CV_32FC4", CV_32FC4);

    constant("CV_64FC1", CV_64FC1);
    constant("CV_64FC2", CV_64FC2);
    constant("CV_64FC3", CV_64FC3);
    constant("CV_64FC4", CV_64FC4);

    constant("CV_8U", CV_8U);
    constant("CV_8S", CV_8S);
    constant("CV_16U", CV_16U);
    constant("CV_16S", CV_16S);
    constant("CV_32S",  CV_32S);
    constant("CV_32F", CV_32F);
    constant("CV_64F", CV_64F);

    constant("INT_MIN", INT_MIN);
    constant("INT_MAX", INT_MAX);
}
namespace Wrappers {
    void Canny_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, bool arg6) {
        return cv::Canny(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void Canny_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5) {
        return cv::Canny(arg1, arg2, arg3, arg4, arg5);
    }
    
    void Canny_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4) {
        return cv::Canny(arg1, arg2, arg3, arg4);
    }
    
    void Canny_wrapper1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4, double arg5, bool arg6) {
        return cv::Canny(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void Canny_wrapper1_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4, double arg5) {
        return cv::Canny(arg1, arg2, arg3, arg4, arg5);
    }
    
    void GaussianBlur_wrapper(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, double arg4, double arg5, int arg6, cv::AlgorithmHint arg7) {
        return cv::GaussianBlur(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void GaussianBlur_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, double arg4, double arg5, int arg6) {
        return cv::GaussianBlur(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void GaussianBlur_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, double arg4, double arg5) {
        return cv::GaussianBlur(arg1, arg2, arg3, arg4, arg5);
    }
    
    void GaussianBlur_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, double arg4) {
        return cv::GaussianBlur(arg1, arg2, arg3, arg4);
    }
    
    void HoughCircles_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, double arg6, double arg7, int arg8, int arg9) {
        return cv::HoughCircles(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void HoughCircles_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, double arg6, double arg7, int arg8) {
        return cv::HoughCircles(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void HoughCircles_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, double arg6, double arg7) {
        return cv::HoughCircles(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void HoughCircles_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, double arg6) {
        return cv::HoughCircles(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void HoughCircles_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5) {
        return cv::HoughCircles(arg1, arg2, arg3, arg4, arg5);
    }
    
    void HoughLines_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, double arg6, double arg7, double arg8, double arg9, bool arg10) {
        return cv::HoughLines(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void HoughLines_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, double arg6, double arg7, double arg8, double arg9) {
        return cv::HoughLines(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void HoughLines_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, double arg6, double arg7, double arg8) {
        return cv::HoughLines(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void HoughLines_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, double arg6, double arg7) {
        return cv::HoughLines(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void HoughLines_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, double arg6) {
        return cv::HoughLines(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void HoughLines_wrapper_5(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5) {
        return cv::HoughLines(arg1, arg2, arg3, arg4, arg5);
    }
    
    void HoughLinesP_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, double arg6, double arg7) {
        return cv::HoughLinesP(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void HoughLinesP_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, double arg6) {
        return cv::HoughLinesP(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void HoughLinesP_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5) {
        return cv::HoughLinesP(arg1, arg2, arg3, arg4, arg5);
    }
    
    void HuMoments_wrapper(const Moments& arg1, cv::Mat& arg2) {
        return cv::HuMoments(arg1, arg2);
    }
    
    void LUT_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::LUT(arg1, arg2, arg3);
    }
    
    void Laplacian_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, double arg5, double arg6, int arg7) {
        return cv::Laplacian(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void Laplacian_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, double arg5, double arg6) {
        return cv::Laplacian(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void Laplacian_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, double arg5) {
        return cv::Laplacian(arg1, arg2, arg3, arg4, arg5);
    }
    
    void Laplacian_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::Laplacian(arg1, arg2, arg3, arg4);
    }
    
    void Laplacian_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::Laplacian(arg1, arg2, arg3);
    }
    
    void Rodrigues_wrapper(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return cv::Rodrigues(arg1, arg2, arg3);
    }
    
    void Rodrigues_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::Rodrigues(arg1, arg2);
    }
    
    void Scharr_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, double arg6, double arg7, int arg8) {
        return cv::Scharr(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void Scharr_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, double arg6, double arg7) {
        return cv::Scharr(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void Scharr_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, double arg6) {
        return cv::Scharr(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void Scharr_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5) {
        return cv::Scharr(arg1, arg2, arg3, arg4, arg5);
    }
    
    void Sobel_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, int arg6, double arg7, double arg8, int arg9) {
        return cv::Sobel(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void Sobel_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, int arg6, double arg7, double arg8) {
        return cv::Sobel(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void Sobel_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, int arg6, double arg7) {
        return cv::Sobel(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void Sobel_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, int arg6) {
        return cv::Sobel(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void Sobel_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5) {
        return cv::Sobel(arg1, arg2, arg3, arg4, arg5);
    }
    
    void absdiff_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::absdiff(arg1, arg2, arg3);
    }
    
    void adaptiveThreshold_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, int arg4, int arg5, int arg6, double arg7) {
        return cv::adaptiveThreshold(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void add_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4, int arg5) {
        return cv::add(arg1, arg2, arg3, arg4, arg5);
    }
    
    void add_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4) {
        return cv::add(arg1, arg2, arg3, arg4);
    }
    
    void add_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::add(arg1, arg2, arg3);
    }
    
    void addWeighted_wrapper(const cv::Mat& arg1, double arg2, const cv::Mat& arg3, double arg4, double arg5, cv::Mat& arg6, int arg7) {
        return cv::addWeighted(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void addWeighted_wrapper_1(const cv::Mat& arg1, double arg2, const cv::Mat& arg3, double arg4, double arg5, cv::Mat& arg6) {
        return cv::addWeighted(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void applyColorMap_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::applyColorMap(arg1, arg2, arg3);
    }
    
    void applyColorMap_wrapper1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::applyColorMap(arg1, arg2, arg3);
    }
    
    void approxPolyDP_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, bool arg4) {
        return cv::approxPolyDP(arg1, arg2, arg3, arg4);
    }
    
    void approxPolyN_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, float arg4, bool arg5) {
        return cv::approxPolyN(arg1, arg2, arg3, arg4, arg5);
    }
    
    void approxPolyN_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, float arg4) {
        return cv::approxPolyN(arg1, arg2, arg3, arg4);
    }
    
    void approxPolyN_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::approxPolyN(arg1, arg2, arg3);
    }
    
    double arcLength_wrapper(const cv::Mat& arg1, bool arg2) {
        return cv::arcLength(arg1, arg2);
    }
    
    void arrowedLine_wrapper(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5, int arg6, int arg7, double arg8) {
        return cv::arrowedLine(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void arrowedLine_wrapper_1(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5, int arg6, int arg7) {
        return cv::arrowedLine(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void arrowedLine_wrapper_2(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5, int arg6) {
        return cv::arrowedLine(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void arrowedLine_wrapper_3(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5) {
        return cv::arrowedLine(arg1, arg2, arg3, arg4, arg5);
    }
    
    void arrowedLine_wrapper_4(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4) {
        return cv::arrowedLine(arg1, arg2, arg3, arg4);
    }
    
    void bilateralFilter_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, int arg6) {
        return cv::bilateralFilter(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void bilateralFilter_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5) {
        return cv::bilateralFilter(arg1, arg2, arg3, arg4, arg5);
    }
    
    void bitwise_and_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4) {
        return cv::bitwise_and(arg1, arg2, arg3, arg4);
    }
    
    void bitwise_and_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::bitwise_and(arg1, arg2, arg3);
    }
    
    void bitwise_not_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::bitwise_not(arg1, arg2, arg3);
    }
    
    void bitwise_not_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::bitwise_not(arg1, arg2);
    }
    
    void bitwise_or_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4) {
        return cv::bitwise_or(arg1, arg2, arg3, arg4);
    }
    
    void bitwise_or_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::bitwise_or(arg1, arg2, arg3);
    }
    
    void bitwise_xor_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4) {
        return cv::bitwise_xor(arg1, arg2, arg3, arg4);
    }
    
    void bitwise_xor_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::bitwise_xor(arg1, arg2, arg3);
    }
    
    void blendLinear_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5) {
        return cv::blendLinear(arg1, arg2, arg3, arg4, arg5);
    }
    
    void blur_wrapper(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, Point arg4, int arg5) {
        return cv::blur(arg1, arg2, arg3, arg4, arg5);
    }
    
    void blur_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, Point arg4) {
        return cv::blur(arg1, arg2, arg3, arg4);
    }
    
    void blur_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, Size arg3) {
        return cv::blur(arg1, arg2, arg3);
    }
    
    Rect boundingRect_wrapper(const cv::Mat& arg1) {
        return cv::boundingRect(arg1);
    }
    
    void boxFilter_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4, Point arg5, bool arg6, int arg7) {
        return cv::boxFilter(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void boxFilter_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4, Point arg5, bool arg6) {
        return cv::boxFilter(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void boxFilter_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4, Point arg5) {
        return cv::boxFilter(arg1, arg2, arg3, arg4, arg5);
    }
    
    void boxFilter_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4) {
        return cv::boxFilter(arg1, arg2, arg3, arg4);
    }
    
    void calcBackProject_wrapper(const std::vector<cv::Mat>& arg1, const emscripten::val& arg2, const cv::Mat& arg3, cv::Mat& arg4, const emscripten::val& arg5, double arg6) {
        return cv::calcBackProject(arg1, emscripten::vecFromJSArray<int>(arg2), arg3, arg4, emscripten::vecFromJSArray<float>(arg5), arg6);
    }
    
    void calcHist_wrapper(const std::vector<cv::Mat>& arg1, const emscripten::val& arg2, const cv::Mat& arg3, cv::Mat& arg4, const emscripten::val& arg5, const emscripten::val& arg6, bool arg7) {
        return cv::calcHist(arg1, emscripten::vecFromJSArray<int>(arg2), arg3, arg4, emscripten::vecFromJSArray<int>(arg5), emscripten::vecFromJSArray<float>(arg6), arg7);
    }
    
    void calcHist_wrapper_1(const std::vector<cv::Mat>& arg1, const emscripten::val& arg2, const cv::Mat& arg3, cv::Mat& arg4, const emscripten::val& arg5, const emscripten::val& arg6) {
        return cv::calcHist(arg1, emscripten::vecFromJSArray<int>(arg2), arg3, arg4, emscripten::vecFromJSArray<int>(arg5), emscripten::vecFromJSArray<float>(arg6));
    }
    
    void calcOpticalFlowFarneback_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4, int arg5, int arg6, int arg7, int arg8, double arg9, int arg10) {
        return cv::calcOpticalFlowFarneback(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void calcOpticalFlowPyrLK_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, Size arg7, int arg8, TermCriteria arg9, int arg10, double arg11) {
        return cv::calcOpticalFlowPyrLK(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11);
    }
    
    void calcOpticalFlowPyrLK_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, Size arg7, int arg8, TermCriteria arg9, int arg10) {
        return cv::calcOpticalFlowPyrLK(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void calcOpticalFlowPyrLK_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, Size arg7, int arg8, TermCriteria arg9) {
        return cv::calcOpticalFlowPyrLK(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void calcOpticalFlowPyrLK_wrapper_3(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, Size arg7, int arg8) {
        return cv::calcOpticalFlowPyrLK(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void calcOpticalFlowPyrLK_wrapper_4(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, Size arg7) {
        return cv::calcOpticalFlowPyrLK(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void calcOpticalFlowPyrLK_wrapper_5(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6) {
        return cv::calcOpticalFlowPyrLK(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    double calibrateCameraExtended_wrapper(const std::vector<cv::Mat>& arg1, const std::vector<cv::Mat>& arg2, Size arg3, cv::Mat& arg4, cv::Mat& arg5, std::vector<cv::Mat>& arg6, std::vector<cv::Mat>& arg7, cv::Mat& arg8, cv::Mat& arg9, cv::Mat& arg10, int arg11, TermCriteria arg12) {
        return cv::calibrateCamera(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11, arg12);
    }
    
    double calibrateCameraExtended_wrapper_1(const std::vector<cv::Mat>& arg1, const std::vector<cv::Mat>& arg2, Size arg3, cv::Mat& arg4, cv::Mat& arg5, std::vector<cv::Mat>& arg6, std::vector<cv::Mat>& arg7, cv::Mat& arg8, cv::Mat& arg9, cv::Mat& arg10, int arg11) {
        return cv::calibrateCamera(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11);
    }
    
    double calibrateCameraExtended_wrapper_2(const std::vector<cv::Mat>& arg1, const std::vector<cv::Mat>& arg2, Size arg3, cv::Mat& arg4, cv::Mat& arg5, std::vector<cv::Mat>& arg6, std::vector<cv::Mat>& arg7, cv::Mat& arg8, cv::Mat& arg9, cv::Mat& arg10) {
        return cv::calibrateCamera(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void cartToPolar_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4, bool arg5) {
        return cv::cartToPolar(arg1, arg2, arg3, arg4, arg5);
    }
    
    void cartToPolar_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4) {
        return cv::cartToPolar(arg1, arg2, arg3, arg4);
    }
    
    void circle_wrapper(cv::Mat& arg1, Point arg2, int arg3, const Scalar& arg4, int arg5, int arg6, int arg7) {
        return cv::circle(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void circle_wrapper_1(cv::Mat& arg1, Point arg2, int arg3, const Scalar& arg4, int arg5, int arg6) {
        return cv::circle(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void circle_wrapper_2(cv::Mat& arg1, Point arg2, int arg3, const Scalar& arg4, int arg5) {
        return cv::circle(arg1, arg2, arg3, arg4, arg5);
    }
    
    void circle_wrapper_3(cv::Mat& arg1, Point arg2, int arg3, const Scalar& arg4) {
        return cv::circle(arg1, arg2, arg3, arg4);
    }
    
    bool clipLine_wrapper(Rect arg1, Point& arg2, Point& arg3) {
        return cv::clipLine(arg1, arg2, arg3);
    }
    
    void compare_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::compare(arg1, arg2, arg3, arg4);
    }
    
    double compareHist_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, int arg3) {
        return cv::compareHist(arg1, arg2, arg3);
    }
    
    int connectedComponents_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::connectedComponents(arg1, arg2, arg3, arg4);
    }
    
    int connectedComponents_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::connectedComponents(arg1, arg2, arg3);
    }
    
    int connectedComponents_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::connectedComponents(arg1, arg2);
    }
    
    int connectedComponentsWithStats_wrapper(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4, int arg5, int arg6) {
        return cv::connectedComponentsWithStats(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    int connectedComponentsWithStats_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4, int arg5) {
        return cv::connectedComponentsWithStats(arg1, arg2, arg3, arg4, arg5);
    }
    
    int connectedComponentsWithStats_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4) {
        return cv::connectedComponentsWithStats(arg1, arg2, arg3, arg4);
    }
    
    double contourArea_wrapper(const cv::Mat& arg1, bool arg2) {
        return cv::contourArea(arg1, arg2);
    }
    
    double contourArea_wrapper_1(const cv::Mat& arg1) {
        return cv::contourArea(arg1);
    }
    
    void convertMaps_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4, int arg5, bool arg6) {
        return cv::convertMaps(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void convertMaps_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4, int arg5) {
        return cv::convertMaps(arg1, arg2, arg3, arg4, arg5);
    }
    
    void convertScaleAbs_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4) {
        return cv::convertScaleAbs(arg1, arg2, arg3, arg4);
    }
    
    void convertScaleAbs_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, double arg3) {
        return cv::convertScaleAbs(arg1, arg2, arg3);
    }
    
    void convertScaleAbs_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::convertScaleAbs(arg1, arg2);
    }
    
    void convexHull_wrapper(const cv::Mat& arg1, cv::Mat& arg2, bool arg3, bool arg4) {
        return cv::convexHull(arg1, arg2, arg3, arg4);
    }
    
    void convexHull_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, bool arg3) {
        return cv::convexHull(arg1, arg2, arg3);
    }
    
    void convexHull_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::convexHull(arg1, arg2);
    }
    
    void convexityDefects_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::convexityDefects(arg1, arg2, arg3);
    }
    
    void copyMakeBorder_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, int arg6, int arg7, const Scalar& arg8) {
        return cv::copyMakeBorder(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void copyMakeBorder_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5, int arg6, int arg7) {
        return cv::copyMakeBorder(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void cornerHarris_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, double arg5, int arg6) {
        return cv::cornerHarris(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void cornerHarris_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, double arg5) {
        return cv::cornerHarris(arg1, arg2, arg3, arg4, arg5);
    }
    
    void cornerMinEigenVal_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5) {
        return cv::cornerMinEigenVal(arg1, arg2, arg3, arg4, arg5);
    }
    
    void cornerMinEigenVal_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::cornerMinEigenVal(arg1, arg2, arg3, arg4);
    }
    
    void cornerMinEigenVal_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::cornerMinEigenVal(arg1, arg2, arg3);
    }
    
    int countNonZero_wrapper(const cv::Mat& arg1) {
        return cv::countNonZero(arg1);
    }
    
    void createHanningWindow_wrapper(cv::Mat& arg1, Size arg2, int arg3) {
        return cv::createHanningWindow(arg1, arg2, arg3);
    }
    
    void cvtColor_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, cv::AlgorithmHint arg5) {
        return cv::cvtColor(arg1, arg2, arg3, arg4, arg5);
    }
    
    void cvtColor_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::cvtColor(arg1, arg2, arg3, arg4);
    }
    
    void cvtColor_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::cvtColor(arg1, arg2, arg3);
    }
    
    void demosaicing_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::demosaicing(arg1, arg2, arg3, arg4);
    }
    
    void demosaicing_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::demosaicing(arg1, arg2, arg3);
    }
    
    double determinant_wrapper(const cv::Mat& arg1) {
        return cv::determinant(arg1);
    }
    
    void dft_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::dft(arg1, arg2, arg3, arg4);
    }
    
    void dft_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::dft(arg1, arg2, arg3);
    }
    
    void dft_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::dft(arg1, arg2);
    }
    
    void dilate_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4, int arg5, int arg6, const Scalar& arg7) {
        return cv::dilate(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void dilate_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4, int arg5, int arg6) {
        return cv::dilate(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void dilate_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4, int arg5) {
        return cv::dilate(arg1, arg2, arg3, arg4, arg5);
    }
    
    void dilate_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4) {
        return cv::dilate(arg1, arg2, arg3, arg4);
    }
    
    void dilate_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::dilate(arg1, arg2, arg3);
    }
    
    void distanceTransform_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5) {
        return cv::distanceTransform(arg1, arg2, arg3, arg4, arg5);
    }
    
    void distanceTransform_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::distanceTransform(arg1, arg2, arg3, arg4);
    }
    
    void distanceTransformWithLabels_wrapper(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, int arg4, int arg5, int arg6) {
        return cv::distanceTransform(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void distanceTransformWithLabels_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, int arg4, int arg5) {
        return cv::distanceTransform(arg1, arg2, arg3, arg4, arg5);
    }
    
    void divSpectrums_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, bool arg5) {
        return cv::divSpectrums(arg1, arg2, arg3, arg4, arg5);
    }
    
    void divSpectrums_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::divSpectrums(arg1, arg2, arg3, arg4);
    }
    
    void divide_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4, int arg5) {
        return cv::divide(arg1, arg2, arg3, arg4, arg5);
    }
    
    void divide_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4) {
        return cv::divide(arg1, arg2, arg3, arg4);
    }
    
    void divide_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::divide(arg1, arg2, arg3);
    }
    
    void divide_wrapper1(double arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::divide(arg1, arg2, arg3, arg4);
    }
    
    void divide_wrapper1_1(double arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::divide(arg1, arg2, arg3);
    }
    
    void drawContours_wrapper(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, int arg3, const Scalar& arg4, int arg5, int arg6, const cv::Mat& arg7, int arg8, Point arg9) {
        return cv::drawContours(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void drawContours_wrapper_1(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, int arg3, const Scalar& arg4, int arg5, int arg6, const cv::Mat& arg7, int arg8) {
        return cv::drawContours(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void drawContours_wrapper_2(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, int arg3, const Scalar& arg4, int arg5, int arg6, const cv::Mat& arg7) {
        return cv::drawContours(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void drawContours_wrapper_3(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, int arg3, const Scalar& arg4, int arg5, int arg6) {
        return cv::drawContours(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void drawContours_wrapper_4(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, int arg3, const Scalar& arg4, int arg5) {
        return cv::drawContours(arg1, arg2, arg3, arg4, arg5);
    }
    
    void drawContours_wrapper_5(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, int arg3, const Scalar& arg4) {
        return cv::drawContours(arg1, arg2, arg3, arg4);
    }
    
    void drawFrameAxes_wrapper(cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, float arg6, int arg7) {
        return cv::drawFrameAxes(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void drawFrameAxes_wrapper_1(cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, float arg6) {
        return cv::drawFrameAxes(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void drawKeypoints_wrapper(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, cv::Mat& arg3, const Scalar& arg4, cv::DrawMatchesFlags arg5) {
        return cv::drawKeypoints(arg1, arg2, arg3, arg4, arg5);
    }
    
    void drawKeypoints_wrapper_1(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, cv::Mat& arg3, const Scalar& arg4) {
        return cv::drawKeypoints(arg1, arg2, arg3, arg4);
    }
    
    void drawKeypoints_wrapper_2(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, cv::Mat& arg3) {
        return cv::drawKeypoints(arg1, arg2, arg3);
    }
    
    void drawMarker_wrapper(cv::Mat& arg1, Point arg2, const Scalar& arg3, int arg4, int arg5, int arg6, int arg7) {
        return cv::drawMarker(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void drawMarker_wrapper_1(cv::Mat& arg1, Point arg2, const Scalar& arg3, int arg4, int arg5, int arg6) {
        return cv::drawMarker(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void drawMarker_wrapper_2(cv::Mat& arg1, Point arg2, const Scalar& arg3, int arg4, int arg5) {
        return cv::drawMarker(arg1, arg2, arg3, arg4, arg5);
    }
    
    void drawMarker_wrapper_3(cv::Mat& arg1, Point arg2, const Scalar& arg3, int arg4) {
        return cv::drawMarker(arg1, arg2, arg3, arg4);
    }
    
    void drawMarker_wrapper_4(cv::Mat& arg1, Point arg2, const Scalar& arg3) {
        return cv::drawMarker(arg1, arg2, arg3);
    }
    
    void drawMatches_wrapper(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const Scalar& arg7, const Scalar& arg8, const emscripten::val& arg9, cv::DrawMatchesFlags arg10) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, emscripten::vecFromJSArray<char>(arg9), arg10);
    }
    
    void drawMatches_wrapper_1(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const Scalar& arg7, const Scalar& arg8, const emscripten::val& arg9) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, emscripten::vecFromJSArray<char>(arg9));
    }
    
    void drawMatches_wrapper_2(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const Scalar& arg7, const Scalar& arg8) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void drawMatches_wrapper_3(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const Scalar& arg7) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void drawMatches_wrapper_4(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void drawMatches_wrapper1(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const int arg7, const Scalar& arg8, const Scalar& arg9, const emscripten::val& arg10, cv::DrawMatchesFlags arg11) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, emscripten::vecFromJSArray<char>(arg10), arg11);
    }
    
    void drawMatches_wrapper1_1(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const int arg7, const Scalar& arg8, const Scalar& arg9, const emscripten::val& arg10) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, emscripten::vecFromJSArray<char>(arg10));
    }
    
    void drawMatches_wrapper1_2(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const int arg7, const Scalar& arg8, const Scalar& arg9) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void drawMatches_wrapper1_3(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const int arg7, const Scalar& arg8) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void drawMatches_wrapper1_4(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<DMatch>& arg5, cv::Mat& arg6, const int arg7) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void drawMatchesKnn_wrapper(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<std::vector<DMatch>>& arg5, cv::Mat& arg6, const Scalar& arg7, const Scalar& arg8, const std::vector<std::vector<char>>& arg9, cv::DrawMatchesFlags arg10) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void drawMatchesKnn_wrapper_1(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<std::vector<DMatch>>& arg5, cv::Mat& arg6, const Scalar& arg7, const Scalar& arg8, const std::vector<std::vector<char>>& arg9) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void drawMatchesKnn_wrapper_2(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<std::vector<DMatch>>& arg5, cv::Mat& arg6, const Scalar& arg7, const Scalar& arg8) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void drawMatchesKnn_wrapper_3(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<std::vector<DMatch>>& arg5, cv::Mat& arg6, const Scalar& arg7) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void drawMatchesKnn_wrapper_4(const cv::Mat& arg1, const std::vector<KeyPoint>& arg2, const cv::Mat& arg3, const std::vector<KeyPoint>& arg4, const std::vector<std::vector<DMatch>>& arg5, cv::Mat& arg6) {
        return cv::drawMatches(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    bool eigen_wrapper(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return cv::eigen(arg1, arg2, arg3);
    }
    
    bool eigen_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::eigen(arg1, arg2);
    }
    
    void ellipse_wrapper(cv::Mat& arg1, Point arg2, Size arg3, double arg4, double arg5, double arg6, const Scalar& arg7, int arg8, int arg9, int arg10) {
        return cv::ellipse(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void ellipse_wrapper_1(cv::Mat& arg1, Point arg2, Size arg3, double arg4, double arg5, double arg6, const Scalar& arg7, int arg8, int arg9) {
        return cv::ellipse(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void ellipse_wrapper_2(cv::Mat& arg1, Point arg2, Size arg3, double arg4, double arg5, double arg6, const Scalar& arg7, int arg8) {
        return cv::ellipse(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void ellipse_wrapper_3(cv::Mat& arg1, Point arg2, Size arg3, double arg4, double arg5, double arg6, const Scalar& arg7) {
        return cv::ellipse(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void ellipse_wrapper1(cv::Mat& arg1, const RotatedRect& arg2, const Scalar& arg3, int arg4, int arg5) {
        return cv::ellipse(arg1, arg2, arg3, arg4, arg5);
    }
    
    void ellipse_wrapper1_1(cv::Mat& arg1, const RotatedRect& arg2, const Scalar& arg3, int arg4) {
        return cv::ellipse(arg1, arg2, arg3, arg4);
    }
    
    void ellipse_wrapper1_2(cv::Mat& arg1, const RotatedRect& arg2, const Scalar& arg3) {
        return cv::ellipse(arg1, arg2, arg3);
    }
    
    void ellipse2Poly_wrapper(Point arg1, Size arg2, int arg3, int arg4, int arg5, int arg6, std::vector<Point>& arg7) {
        return cv::ellipse2Poly(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void equalizeHist_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::equalizeHist(arg1, arg2);
    }
    
    void erode_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4, int arg5, int arg6, const Scalar& arg7) {
        return cv::erode(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void erode_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4, int arg5, int arg6) {
        return cv::erode(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void erode_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4, int arg5) {
        return cv::erode(arg1, arg2, arg3, arg4, arg5);
    }
    
    void erode_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Point arg4) {
        return cv::erode(arg1, arg2, arg3, arg4);
    }
    
    void erode_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::erode(arg1, arg2, arg3);
    }
    
    Mat estimateAffine2D_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, double arg5, size_t arg6, double arg7, size_t arg8) {
        return cv::estimateAffine2D(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    Mat estimateAffine2D_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, double arg5, size_t arg6, double arg7) {
        return cv::estimateAffine2D(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    Mat estimateAffine2D_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, double arg5, size_t arg6) {
        return cv::estimateAffine2D(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Mat estimateAffine2D_wrapper_3(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, double arg5) {
        return cv::estimateAffine2D(arg1, arg2, arg3, arg4, arg5);
    }
    
    Mat estimateAffine2D_wrapper_4(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::estimateAffine2D(arg1, arg2, arg3, arg4);
    }
    
    Mat estimateAffine2D_wrapper_5(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::estimateAffine2D(arg1, arg2, arg3);
    }
    
    Mat estimateAffine2D_wrapper_6(const cv::Mat& arg1, const cv::Mat& arg2) {
        return cv::estimateAffine2D(arg1, arg2);
    }
    
    Mat estimateAffine2D_wrapper1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const UsacParams& arg4) {
        return cv::estimateAffine2D(arg1, arg2, arg3, arg4);
    }
    
    void exp_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::exp(arg1, arg2);
    }
    
    void fillConvexPoly_wrapper(cv::Mat& arg1, const cv::Mat& arg2, const Scalar& arg3, int arg4, int arg5) {
        return cv::fillConvexPoly(arg1, arg2, arg3, arg4, arg5);
    }
    
    void fillConvexPoly_wrapper_1(cv::Mat& arg1, const cv::Mat& arg2, const Scalar& arg3, int arg4) {
        return cv::fillConvexPoly(arg1, arg2, arg3, arg4);
    }
    
    void fillConvexPoly_wrapper_2(cv::Mat& arg1, const cv::Mat& arg2, const Scalar& arg3) {
        return cv::fillConvexPoly(arg1, arg2, arg3);
    }
    
    void fillPoly_wrapper(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const Scalar& arg3, int arg4, int arg5, Point arg6) {
        return cv::fillPoly(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void fillPoly_wrapper_1(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const Scalar& arg3, int arg4, int arg5) {
        return cv::fillPoly(arg1, arg2, arg3, arg4, arg5);
    }
    
    void fillPoly_wrapper_2(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const Scalar& arg3, int arg4) {
        return cv::fillPoly(arg1, arg2, arg3, arg4);
    }
    
    void fillPoly_wrapper_3(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const Scalar& arg3) {
        return cv::fillPoly(arg1, arg2, arg3);
    }
    
    void filter2D_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, Point arg5, double arg6, int arg7) {
        return cv::filter2D(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void filter2D_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, Point arg5, double arg6) {
        return cv::filter2D(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void filter2D_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, Point arg5) {
        return cv::filter2D(arg1, arg2, arg3, arg4, arg5);
    }
    
    void filter2D_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4) {
        return cv::filter2D(arg1, arg2, arg3, arg4);
    }
    
    void findContours_wrapper(const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3, int arg4, int arg5, Point arg6) {
        return cv::findContours(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void findContours_wrapper_1(const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3, int arg4, int arg5) {
        return cv::findContours(arg1, arg2, arg3, arg4, arg5);
    }
    
    void findContoursLinkRuns_wrapper(const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3) {
        return cv::findContoursLinkRuns(arg1, arg2, arg3);
    }
    
    void findContoursLinkRuns_wrapper1(const cv::Mat& arg1, std::vector<cv::Mat>& arg2) {
        return cv::findContoursLinkRuns(arg1, arg2);
    }
    
    Mat findHomography_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, int arg3, double arg4, cv::Mat& arg5, const int arg6, const double arg7) {
        return cv::findHomography(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    Mat findHomography_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, int arg3, double arg4, cv::Mat& arg5, const int arg6) {
        return cv::findHomography(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Mat findHomography_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, int arg3, double arg4, cv::Mat& arg5) {
        return cv::findHomography(arg1, arg2, arg3, arg4, arg5);
    }
    
    Mat findHomography_wrapper_3(const cv::Mat& arg1, const cv::Mat& arg2, int arg3, double arg4) {
        return cv::findHomography(arg1, arg2, arg3, arg4);
    }
    
    Mat findHomography_wrapper_4(const cv::Mat& arg1, const cv::Mat& arg2, int arg3) {
        return cv::findHomography(arg1, arg2, arg3);
    }
    
    Mat findHomography_wrapper_5(const cv::Mat& arg1, const cv::Mat& arg2) {
        return cv::findHomography(arg1, arg2);
    }
    
    Mat findHomography_wrapper1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const UsacParams& arg4) {
        return cv::findHomography(arg1, arg2, arg3, arg4);
    }
    
    double findTransformECC_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, TermCriteria arg5, const cv::Mat& arg6, int arg7) {
        return cv::findTransformECC(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    double findTransformECC_wrapper1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, TermCriteria arg5, const cv::Mat& arg6) {
        return cv::findTransformECC(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    double findTransformECC_wrapper1_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, TermCriteria arg5) {
        return cv::findTransformECC(arg1, arg2, arg3, arg4, arg5);
    }
    
    double findTransformECC_wrapper1_2(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::findTransformECC(arg1, arg2, arg3, arg4);
    }
    
    double findTransformECC_wrapper1_3(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::findTransformECC(arg1, arg2, arg3);
    }
    
    RotatedRect fitEllipse_wrapper(const cv::Mat& arg1) {
        return cv::fitEllipse(arg1);
    }
    
    RotatedRect fitEllipseAMS_wrapper(const cv::Mat& arg1) {
        return cv::fitEllipseAMS(arg1);
    }
    
    RotatedRect fitEllipseDirect_wrapper(const cv::Mat& arg1) {
        return cv::fitEllipseDirect(arg1);
    }
    
    void fitLine_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, double arg6) {
        return cv::fitLine(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void flip_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::flip(arg1, arg2, arg3);
    }
    
    void gemm_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, double arg3, const cv::Mat& arg4, double arg5, cv::Mat& arg6, int arg7) {
        return cv::gemm(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void gemm_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, double arg3, const cv::Mat& arg4, double arg5, cv::Mat& arg6) {
        return cv::gemm(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Mat getAffineTransform_wrapper(const cv::Mat& arg1, const cv::Mat& arg2) {
        return cv::getAffineTransform(arg1, arg2);
    }
    
    Mat getDefaultNewCameraMatrix_wrapper(const cv::Mat& arg1, Size arg2, bool arg3) {
        return cv::getDefaultNewCameraMatrix(arg1, arg2, arg3);
    }
    
    Mat getDefaultNewCameraMatrix_wrapper_1(const cv::Mat& arg1, Size arg2) {
        return cv::getDefaultNewCameraMatrix(arg1, arg2);
    }
    
    Mat getDefaultNewCameraMatrix_wrapper_2(const cv::Mat& arg1) {
        return cv::getDefaultNewCameraMatrix(arg1);
    }
    
    double getFontScaleFromHeight_wrapper(const int arg1, const int arg2, const int arg3) {
        return cv::getFontScaleFromHeight(arg1, arg2, arg3);
    }
    
    double getFontScaleFromHeight_wrapper_1(const int arg1, const int arg2) {
        return cv::getFontScaleFromHeight(arg1, arg2);
    }
    
    int getOptimalDFTSize_wrapper(int arg1) {
        return cv::getOptimalDFTSize(arg1);
    }
    
    Mat getPerspectiveTransform_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, int arg3) {
        return cv::getPerspectiveTransform(arg1, arg2, arg3);
    }
    
    Mat getPerspectiveTransform_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2) {
        return cv::getPerspectiveTransform(arg1, arg2);
    }
    
    void getRectSubPix_wrapper(const cv::Mat& arg1, Size arg2, Point2f arg3, cv::Mat& arg4, int arg5) {
        return cv::getRectSubPix(arg1, arg2, arg3, arg4, arg5);
    }
    
    void getRectSubPix_wrapper_1(const cv::Mat& arg1, Size arg2, Point2f arg3, cv::Mat& arg4) {
        return cv::getRectSubPix(arg1, arg2, arg3, arg4);
    }
    
    Mat getRotationMatrix2D_wrapper(Point2f arg1, double arg2, double arg3) {
        return cv::getRotationMatrix2D(arg1, arg2, arg3);
    }
    
    Mat getStructuringElement_wrapper(int arg1, Size arg2, Point arg3) {
        return cv::getStructuringElement(arg1, arg2, arg3);
    }
    
    Mat getStructuringElement_wrapper_1(int arg1, Size arg2) {
        return cv::getStructuringElement(arg1, arg2);
    }
    
    void goodFeaturesToTrack_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, const cv::Mat& arg6, int arg7, bool arg8, double arg9) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void goodFeaturesToTrack_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, const cv::Mat& arg6, int arg7, bool arg8) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void goodFeaturesToTrack_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, const cv::Mat& arg6, int arg7) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void goodFeaturesToTrack_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, const cv::Mat& arg6) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void goodFeaturesToTrack_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5);
    }
    
    void goodFeaturesToTrack_wrapper1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, const cv::Mat& arg6, int arg7, int arg8, bool arg9, double arg10) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void goodFeaturesToTrack_wrapper1_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, const cv::Mat& arg6, int arg7, int arg8, bool arg9) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void goodFeaturesToTrack_wrapper1_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, double arg4, double arg5, const cv::Mat& arg6, int arg7, int arg8) {
        return cv::goodFeaturesToTrack(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void grabCut_wrapper(const cv::Mat& arg1, cv::Mat& arg2, Rect arg3, cv::Mat& arg4, cv::Mat& arg5, int arg6, int arg7) {
        return cv::grabCut(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void grabCut_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, Rect arg3, cv::Mat& arg4, cv::Mat& arg5, int arg6) {
        return cv::grabCut(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void groupRectangles_wrapper(std::vector<Rect>& arg1, std::vector<int>& arg2, int arg3, double arg4) {
        return cv::groupRectangles(arg1, arg2, arg3, arg4);
    }
    
    void groupRectangles_wrapper_1(std::vector<Rect>& arg1, std::vector<int>& arg2, int arg3) {
        return cv::groupRectangles(arg1, arg2, arg3);
    }
    
    void hconcat_wrapper(const std::vector<cv::Mat>& arg1, cv::Mat& arg2) {
        return cv::hconcat(arg1, arg2);
    }
    
    void inRange_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, cv::Mat& arg4) {
        return cv::inRange(arg1, arg2, arg3, arg4);
    }
    
    void initUndistortRectifyMap_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, Size arg5, int arg6, cv::Mat& arg7, cv::Mat& arg8) {
        return cv::initUndistortRectifyMap(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void inpaint_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4, int arg5) {
        return cv::inpaint(arg1, arg2, arg3, arg4, arg5);
    }
    
    void integral_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::integral(arg1, arg2, arg3);
    }
    
    void integral_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::integral(arg1, arg2);
    }
    
    void integral2_wrapper(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, int arg4, int arg5) {
        return cv::integral(arg1, arg2, arg3, arg4, arg5);
    }
    
    void integral2_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::integral(arg1, arg2, arg3, arg4);
    }
    
    void integral2_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return cv::integral(arg1, arg2, arg3);
    }
    
    float intersectConvexConvex_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, bool arg4) {
        return cv::intersectConvexConvex(arg1, arg2, arg3, arg4);
    }
    
    float intersectConvexConvex_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::intersectConvexConvex(arg1, arg2, arg3);
    }
    
    double invert_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::invert(arg1, arg2, arg3);
    }
    
    double invert_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::invert(arg1, arg2);
    }
    
    void invertAffineTransform_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::invertAffineTransform(arg1, arg2);
    }
    
    bool isContourConvex_wrapper(const cv::Mat& arg1) {
        return cv::isContourConvex(arg1);
    }
    
    double kmeans_wrapper(const cv::Mat& arg1, int arg2, cv::Mat& arg3, TermCriteria arg4, int arg5, int arg6, cv::Mat& arg7) {
        return cv::kmeans(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    double kmeans_wrapper_1(const cv::Mat& arg1, int arg2, cv::Mat& arg3, TermCriteria arg4, int arg5, int arg6) {
        return cv::kmeans(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void line_wrapper(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5, int arg6, int arg7) {
        return cv::line(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void line_wrapper_1(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5, int arg6) {
        return cv::line(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void line_wrapper_2(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5) {
        return cv::line(arg1, arg2, arg3, arg4, arg5);
    }
    
    void line_wrapper_3(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4) {
        return cv::line(arg1, arg2, arg3, arg4);
    }
    
    void log_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::log(arg1, arg2);
    }
    
    void magnitude_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::magnitude(arg1, arg2, arg3);
    }
    
    double matchShapes_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, int arg3, double arg4) {
        return cv::matchShapes(arg1, arg2, arg3, arg4);
    }
    
    void matchTemplate_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4, const cv::Mat& arg5) {
        return cv::matchTemplate(arg1, arg2, arg3, arg4, arg5);
    }
    
    void matchTemplate_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::matchTemplate(arg1, arg2, arg3, arg4);
    }
    
    void max_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::max(arg1, arg2, arg3);
    }
    
    Scalar mean_wrapper(const cv::Mat& arg1, const cv::Mat& arg2) {
        return cv::mean(arg1, arg2);
    }
    
    Scalar mean_wrapper_1(const cv::Mat& arg1) {
        return cv::mean(arg1);
    }
    
    void meanStdDev_wrapper(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4) {
        return cv::meanStdDev(arg1, arg2, arg3, arg4);
    }
    
    void meanStdDev_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return cv::meanStdDev(arg1, arg2, arg3);
    }
    
    void medianBlur_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::medianBlur(arg1, arg2, arg3);
    }
    
    void merge_wrapper(const std::vector<cv::Mat>& arg1, cv::Mat& arg2) {
        return cv::merge(arg1, arg2);
    }
    
    void min_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::min(arg1, arg2, arg3);
    }
    
    RotatedRect minAreaRect_wrapper(const cv::Mat& arg1) {
        return cv::minAreaRect(arg1);
    }
    
    double minEnclosingTriangle_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::minEnclosingTriangle(arg1, arg2);
    }
    
    void mixChannels_wrapper(const std::vector<cv::Mat>& arg1, std::vector<cv::Mat>& arg2, const emscripten::val& arg3) {
        return cv::mixChannels(arg1, arg2, emscripten::vecFromJSArray<int>(arg3));
    }
    
    Moments moments_wrapper(const cv::Mat& arg1, bool arg2) {
        return cv::moments(arg1, arg2);
    }
    
    Moments moments_wrapper_1(const cv::Mat& arg1) {
        return cv::moments(arg1);
    }
    
    void morphologyEx_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, Point arg5, int arg6, int arg7, const Scalar& arg8) {
        return cv::morphologyEx(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void morphologyEx_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, Point arg5, int arg6, int arg7) {
        return cv::morphologyEx(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void morphologyEx_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, Point arg5, int arg6) {
        return cv::morphologyEx(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void morphologyEx_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, Point arg5) {
        return cv::morphologyEx(arg1, arg2, arg3, arg4, arg5);
    }
    
    void morphologyEx_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4) {
        return cv::morphologyEx(arg1, arg2, arg3, arg4);
    }
    
    void multiply_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4, int arg5) {
        return cv::multiply(arg1, arg2, arg3, arg4, arg5);
    }
    
    void multiply_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4) {
        return cv::multiply(arg1, arg2, arg3, arg4);
    }
    
    void multiply_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::multiply(arg1, arg2, arg3);
    }
    
    double norm_wrapper(const cv::Mat& arg1, int arg2, const cv::Mat& arg3) {
        return cv::norm(arg1, arg2, arg3);
    }
    
    double norm_wrapper_1(const cv::Mat& arg1, int arg2) {
        return cv::norm(arg1, arg2);
    }
    
    double norm_wrapper_2(const cv::Mat& arg1) {
        return cv::norm(arg1);
    }
    
    double norm_wrapper1(const cv::Mat& arg1, const cv::Mat& arg2, int arg3, const cv::Mat& arg4) {
        return cv::norm(arg1, arg2, arg3, arg4);
    }
    
    double norm_wrapper1_1(const cv::Mat& arg1, const cv::Mat& arg2, int arg3) {
        return cv::norm(arg1, arg2, arg3);
    }
    
    double norm_wrapper1_2(const cv::Mat& arg1, const cv::Mat& arg2) {
        return cv::norm(arg1, arg2);
    }
    
    void normalize_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, int arg6, const cv::Mat& arg7) {
        return cv::normalize(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void normalize_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5, int arg6) {
        return cv::normalize(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void normalize_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5) {
        return cv::normalize(arg1, arg2, arg3, arg4, arg5);
    }
    
    void normalize_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4) {
        return cv::normalize(arg1, arg2, arg3, arg4);
    }
    
    void normalize_wrapper_4(const cv::Mat& arg1, cv::Mat& arg2, double arg3) {
        return cv::normalize(arg1, arg2, arg3);
    }
    
    void normalize_wrapper_5(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::normalize(arg1, arg2);
    }
    
    void perspectiveTransform_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::perspectiveTransform(arg1, arg2, arg3);
    }
    
    double pointPolygonTest_wrapper(const cv::Mat& arg1, Point2f arg2, bool arg3) {
        return cv::pointPolygonTest(arg1, arg2, arg3);
    }
    
    void polarToCart_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4, bool arg5) {
        return cv::polarToCart(arg1, arg2, arg3, arg4, arg5);
    }
    
    void polarToCart_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4) {
        return cv::polarToCart(arg1, arg2, arg3, arg4);
    }
    
    void polylines_wrapper(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, bool arg3, const Scalar& arg4, int arg5, int arg6, int arg7) {
        return cv::polylines(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void polylines_wrapper_1(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, bool arg3, const Scalar& arg4, int arg5, int arg6) {
        return cv::polylines(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void polylines_wrapper_2(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, bool arg3, const Scalar& arg4, int arg5) {
        return cv::polylines(arg1, arg2, arg3, arg4, arg5);
    }
    
    void polylines_wrapper_3(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, bool arg3, const Scalar& arg4) {
        return cv::polylines(arg1, arg2, arg3, arg4);
    }
    
    void pow_wrapper(const cv::Mat& arg1, double arg2, cv::Mat& arg3) {
        return cv::pow(arg1, arg2, arg3);
    }
    
    void preCornerDetect_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::preCornerDetect(arg1, arg2, arg3, arg4);
    }
    
    void preCornerDetect_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::preCornerDetect(arg1, arg2, arg3);
    }
    
    void projectPoints_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, cv::Mat& arg6, cv::Mat& arg7, double arg8) {
        return cv::projectPoints(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void projectPoints_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, cv::Mat& arg6, cv::Mat& arg7) {
        return cv::projectPoints(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void projectPoints_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, cv::Mat& arg6) {
        return cv::projectPoints(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void putText_wrapper(cv::Mat& arg1, const std::string& arg2, Point arg3, int arg4, double arg5, Scalar arg6, int arg7, int arg8, bool arg9) {
        return cv::putText(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void putText_wrapper_1(cv::Mat& arg1, const std::string& arg2, Point arg3, int arg4, double arg5, Scalar arg6, int arg7, int arg8) {
        return cv::putText(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void putText_wrapper_2(cv::Mat& arg1, const std::string& arg2, Point arg3, int arg4, double arg5, Scalar arg6, int arg7) {
        return cv::putText(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void putText_wrapper_3(cv::Mat& arg1, const std::string& arg2, Point arg3, int arg4, double arg5, Scalar arg6) {
        return cv::putText(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void pyrDown_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const Size& arg3, int arg4) {
        return cv::pyrDown(arg1, arg2, arg3, arg4);
    }
    
    void pyrDown_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const Size& arg3) {
        return cv::pyrDown(arg1, arg2, arg3);
    }
    
    void pyrDown_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::pyrDown(arg1, arg2);
    }
    
    void pyrUp_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const Size& arg3, int arg4) {
        return cv::pyrUp(arg1, arg2, arg3, arg4);
    }
    
    void pyrUp_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const Size& arg3) {
        return cv::pyrUp(arg1, arg2, arg3);
    }
    
    void pyrUp_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::pyrUp(arg1, arg2);
    }
    
    void randn_wrapper(cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::randn(arg1, arg2, arg3);
    }
    
    void randu_wrapper(cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::randu(arg1, arg2, arg3);
    }
    
    void rectangle_wrapper(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5, int arg6, int arg7) {
        return cv::rectangle(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void rectangle_wrapper_1(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5, int arg6) {
        return cv::rectangle(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void rectangle_wrapper_2(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4, int arg5) {
        return cv::rectangle(arg1, arg2, arg3, arg4, arg5);
    }
    
    void rectangle_wrapper_3(cv::Mat& arg1, Point arg2, Point arg3, const Scalar& arg4) {
        return cv::rectangle(arg1, arg2, arg3, arg4);
    }
    
    void rectangle_wrapper1(cv::Mat& arg1, Rect arg2, const Scalar& arg3, int arg4, int arg5, int arg6) {
        return cv::rectangle(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void rectangle_wrapper1_1(cv::Mat& arg1, Rect arg2, const Scalar& arg3, int arg4, int arg5) {
        return cv::rectangle(arg1, arg2, arg3, arg4, arg5);
    }
    
    void rectangle_wrapper1_2(cv::Mat& arg1, Rect arg2, const Scalar& arg3, int arg4) {
        return cv::rectangle(arg1, arg2, arg3, arg4);
    }
    
    void rectangle_wrapper1_3(cv::Mat& arg1, Rect arg2, const Scalar& arg3) {
        return cv::rectangle(arg1, arg2, arg3);
    }
    
    void reduce_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4, int arg5) {
        return cv::reduce(arg1, arg2, arg3, arg4, arg5);
    }
    
    void reduce_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, int arg4) {
        return cv::reduce(arg1, arg2, arg3, arg4);
    }
    
    void remap_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, int arg5, int arg6, const Scalar& arg7) {
        return cv::remap(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void remap_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, int arg5, int arg6) {
        return cv::remap(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void remap_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, int arg5) {
        return cv::remap(arg1, arg2, arg3, arg4, arg5);
    }
    
    void repeat_wrapper(const cv::Mat& arg1, int arg2, int arg3, cv::Mat& arg4) {
        return cv::repeat(arg1, arg2, arg3, arg4);
    }
    
    void resize_wrapper(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, double arg4, double arg5, int arg6) {
        return cv::resize(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void resize_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, double arg4, double arg5) {
        return cv::resize(arg1, arg2, arg3, arg4, arg5);
    }
    
    void resize_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, double arg4) {
        return cv::resize(arg1, arg2, arg3, arg4);
    }
    
    void resize_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, Size arg3) {
        return cv::resize(arg1, arg2, arg3);
    }
    
    void rotate_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::rotate(arg1, arg2, arg3);
    }
    
    int rotatedRectangleIntersection_wrapper(const RotatedRect& arg1, const RotatedRect& arg2, cv::Mat& arg3) {
        return cv::rotatedRectangleIntersection(arg1, arg2, arg3);
    }
    
    void sepFilter2D_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, const cv::Mat& arg5, Point arg6, double arg7, int arg8) {
        return cv::sepFilter2D(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void sepFilter2D_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, const cv::Mat& arg5, Point arg6, double arg7) {
        return cv::sepFilter2D(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void sepFilter2D_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, const cv::Mat& arg5, Point arg6) {
        return cv::sepFilter2D(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void sepFilter2D_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, const cv::Mat& arg4, const cv::Mat& arg5) {
        return cv::sepFilter2D(arg1, arg2, arg3, arg4, arg5);
    }
    
    void setIdentity_wrapper(cv::Mat& arg1, const Scalar& arg2) {
        return cv::setIdentity(arg1, arg2);
    }
    
    void setIdentity_wrapper_1(cv::Mat& arg1) {
        return cv::setIdentity(arg1);
    }
    
    void setRNGSeed_wrapper(int arg1) {
        return cv::setRNGSeed(arg1);
    }
    
    bool solve_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::solve(arg1, arg2, arg3, arg4);
    }
    
    bool solve_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::solve(arg1, arg2, arg3);
    }
    
    bool solvePnP_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7, int arg8) {
        return cv::solvePnP(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    bool solvePnP_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7) {
        return cv::solvePnP(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    bool solvePnP_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6) {
        return cv::solvePnP(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    bool solvePnPRansac_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7, int arg8, float arg9, double arg10, cv::Mat& arg11, int arg12) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11, arg12);
    }
    
    bool solvePnPRansac_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7, int arg8, float arg9, double arg10, cv::Mat& arg11) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11);
    }
    
    bool solvePnPRansac_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7, int arg8, float arg9, double arg10) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    bool solvePnPRansac_wrapper_3(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7, int arg8, float arg9) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    bool solvePnPRansac_wrapper_4(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7, int arg8) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    bool solvePnPRansac_wrapper_5(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, bool arg7) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    bool solvePnPRansac_wrapper_6(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    bool solvePnPRansac_wrapper1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, cv::Mat& arg7, const UsacParams& arg8) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    bool solvePnPRansac_wrapper1_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, cv::Mat& arg7) {
        return cv::solvePnPRansac(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void solvePnPRefineLM_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6, TermCriteria arg7) {
        return cv::solvePnPRefineLM(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void solvePnPRefineLM_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, cv::Mat& arg5, cv::Mat& arg6) {
        return cv::solvePnPRefineLM(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    double solvePoly_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3) {
        return cv::solvePoly(arg1, arg2, arg3);
    }
    
    double solvePoly_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::solvePoly(arg1, arg2);
    }
    
    void spatialGradient_wrapper(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, int arg4, int arg5) {
        return cv::spatialGradient(arg1, arg2, arg3, arg4, arg5);
    }
    
    void spatialGradient_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, int arg4) {
        return cv::spatialGradient(arg1, arg2, arg3, arg4);
    }
    
    void spatialGradient_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return cv::spatialGradient(arg1, arg2, arg3);
    }
    
    void split_wrapper(const cv::Mat& arg1, std::vector<cv::Mat>& arg2) {
        return cv::split(arg1, arg2);
    }
    
    void sqrBoxFilter_wrapper(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4, Point arg5, bool arg6, int arg7) {
        return cv::sqrBoxFilter(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void sqrBoxFilter_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4, Point arg5, bool arg6) {
        return cv::sqrBoxFilter(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void sqrBoxFilter_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4, Point arg5) {
        return cv::sqrBoxFilter(arg1, arg2, arg3, arg4, arg5);
    }
    
    void sqrBoxFilter_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, int arg3, Size arg4) {
        return cv::sqrBoxFilter(arg1, arg2, arg3, arg4);
    }
    
    void sqrt_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::sqrt(arg1, arg2);
    }
    
    void stackBlur_wrapper(const cv::Mat& arg1, cv::Mat& arg2, Size arg3) {
        return cv::stackBlur(arg1, arg2, arg3);
    }
    
    void subtract_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4, int arg5) {
        return cv::subtract(arg1, arg2, arg3, arg4, arg5);
    }
    
    void subtract_wrapper_1(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, const cv::Mat& arg4) {
        return cv::subtract(arg1, arg2, arg3, arg4);
    }
    
    void subtract_wrapper_2(const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return cv::subtract(arg1, arg2, arg3);
    }
    
    double threshold_wrapper(const cv::Mat& arg1, cv::Mat& arg2, double arg3, double arg4, int arg5) {
        return cv::threshold(arg1, arg2, arg3, arg4, arg5);
    }
    
    Scalar trace_wrapper(const cv::Mat& arg1) {
        return cv::trace(arg1);
    }
    
    void transform_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::transform(arg1, arg2, arg3);
    }
    
    void transpose_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::transpose(arg1, arg2);
    }
    
    void undistort_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5) {
        return cv::undistort(arg1, arg2, arg3, arg4, arg5);
    }
    
    void undistort_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4) {
        return cv::undistort(arg1, arg2, arg3, arg4);
    }
    
    void vconcat_wrapper(const std::vector<cv::Mat>& arg1, cv::Mat& arg2) {
        return cv::vconcat(arg1, arg2);
    }
    
    void warpAffine_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4, int arg5, int arg6, const Scalar& arg7) {
        return cv::warpAffine(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void warpAffine_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4, int arg5, int arg6) {
        return cv::warpAffine(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void warpAffine_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4, int arg5) {
        return cv::warpAffine(arg1, arg2, arg3, arg4, arg5);
    }
    
    void warpAffine_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4) {
        return cv::warpAffine(arg1, arg2, arg3, arg4);
    }
    
    void warpPerspective_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4, int arg5, int arg6, const Scalar& arg7) {
        return cv::warpPerspective(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void warpPerspective_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4, int arg5, int arg6) {
        return cv::warpPerspective(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void warpPerspective_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4, int arg5) {
        return cv::warpPerspective(arg1, arg2, arg3, arg4, arg5);
    }
    
    void warpPerspective_wrapper_3(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, Size arg4) {
        return cv::warpPerspective(arg1, arg2, arg3, arg4);
    }
    
    void warpPolar_wrapper(const cv::Mat& arg1, cv::Mat& arg2, Size arg3, Point2f arg4, double arg5, int arg6) {
        return cv::warpPolar(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void watershed_wrapper(const cv::Mat& arg1, cv::Mat& arg2) {
        return cv::watershed(arg1, arg2);
    }
    
    void drawDetectedCornersCharuco_wrapper(cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, Scalar arg4) {
        return cv::aruco::drawDetectedCornersCharuco(arg1, arg2, arg3, arg4);
    }
    
    void drawDetectedCornersCharuco_wrapper_1(cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3) {
        return cv::aruco::drawDetectedCornersCharuco(arg1, arg2, arg3);
    }
    
    void drawDetectedCornersCharuco_wrapper_2(cv::Mat& arg1, const cv::Mat& arg2) {
        return cv::aruco::drawDetectedCornersCharuco(arg1, arg2);
    }
    
    void drawDetectedDiamonds_wrapper(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const cv::Mat& arg3, Scalar arg4) {
        return cv::aruco::drawDetectedDiamonds(arg1, arg2, arg3, arg4);
    }
    
    void drawDetectedDiamonds_wrapper_1(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const cv::Mat& arg3) {
        return cv::aruco::drawDetectedDiamonds(arg1, arg2, arg3);
    }
    
    void drawDetectedDiamonds_wrapper_2(cv::Mat& arg1, const std::vector<cv::Mat>& arg2) {
        return cv::aruco::drawDetectedDiamonds(arg1, arg2);
    }
    
    void drawDetectedMarkers_wrapper(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const cv::Mat& arg3, Scalar arg4) {
        return cv::aruco::drawDetectedMarkers(arg1, arg2, arg3, arg4);
    }
    
    void drawDetectedMarkers_wrapper_1(cv::Mat& arg1, const std::vector<cv::Mat>& arg2, const cv::Mat& arg3) {
        return cv::aruco::drawDetectedMarkers(arg1, arg2, arg3);
    }
    
    void drawDetectedMarkers_wrapper_2(cv::Mat& arg1, const std::vector<cv::Mat>& arg2) {
        return cv::aruco::drawDetectedMarkers(arg1, arg2);
    }
    
    Dictionary extendDictionary_wrapper(int arg1, int arg2, const Dictionary& arg3, int arg4) {
        return cv::aruco::extendDictionary(arg1, arg2, arg3, arg4);
    }
    
    Dictionary extendDictionary_wrapper_1(int arg1, int arg2, const Dictionary& arg3) {
        return cv::aruco::extendDictionary(arg1, arg2, arg3);
    }
    
    Dictionary extendDictionary_wrapper_2(int arg1, int arg2) {
        return cv::aruco::extendDictionary(arg1, arg2);
    }
    
    void generateImageMarker_wrapper(const Dictionary& arg1, int arg2, int arg3, cv::Mat& arg4, int arg5) {
        return cv::aruco::generateImageMarker(arg1, arg2, arg3, arg4, arg5);
    }
    
    void generateImageMarker_wrapper_1(const Dictionary& arg1, int arg2, int arg3, cv::Mat& arg4) {
        return cv::aruco::generateImageMarker(arg1, arg2, arg3, arg4);
    }
    
    Dictionary getPredefinedDictionary_wrapper(int arg1) {
        return cv::aruco::getPredefinedDictionary(arg1);
    }
    
    Mat blobFromImage_wrapper(const cv::Mat& arg1, double arg2, const Size& arg3, const Scalar& arg4, bool arg5, bool arg6, int arg7) {
        return cv::dnn::blobFromImage(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    Mat blobFromImage_wrapper_1(const cv::Mat& arg1, double arg2, const Size& arg3, const Scalar& arg4, bool arg5, bool arg6) {
        return cv::dnn::blobFromImage(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Mat blobFromImage_wrapper_2(const cv::Mat& arg1, double arg2, const Size& arg3, const Scalar& arg4, bool arg5) {
        return cv::dnn::blobFromImage(arg1, arg2, arg3, arg4, arg5);
    }
    
    Mat blobFromImage_wrapper_3(const cv::Mat& arg1, double arg2, const Size& arg3, const Scalar& arg4) {
        return cv::dnn::blobFromImage(arg1, arg2, arg3, arg4);
    }
    
    Mat blobFromImage_wrapper_4(const cv::Mat& arg1, double arg2, const Size& arg3) {
        return cv::dnn::blobFromImage(arg1, arg2, arg3);
    }
    
    Mat blobFromImage_wrapper_5(const cv::Mat& arg1, double arg2) {
        return cv::dnn::blobFromImage(arg1, arg2);
    }
    
    Mat blobFromImage_wrapper_6(const cv::Mat& arg1) {
        return cv::dnn::blobFromImage(arg1);
    }
    
    Net readNet_wrapper(const std::string& arg1, const std::string& arg2, const std::string& arg3) {
        return cv::dnn::readNet(arg1, arg2, arg3);
    }
    
    Net readNet_wrapper_1(const std::string& arg1, const std::string& arg2) {
        return cv::dnn::readNet(arg1, arg2);
    }
    
    Net readNet_wrapper_2(const std::string& arg1) {
        return cv::dnn::readNet(arg1);
    }
    
    Net readNet_wrapper1(const std::string& arg1, const emscripten::val& arg2, const emscripten::val& arg3) {
        return cv::dnn::readNet(arg1, emscripten::vecFromJSArray<uchar>(arg2), emscripten::vecFromJSArray<uchar>(arg3));
    }
    
    Net readNet_wrapper1_1(const std::string& arg1, const emscripten::val& arg2) {
        return cv::dnn::readNet(arg1, emscripten::vecFromJSArray<uchar>(arg2));
    }
    
    Net readNetFromCaffe_wrapper(const std::string& arg1, const std::string& arg2) {
        return cv::dnn::readNetFromCaffe(arg1, arg2);
    }
    
    Net readNetFromCaffe_wrapper_1(const std::string& arg1) {
        return cv::dnn::readNetFromCaffe(arg1);
    }
    
    Net readNetFromCaffe_wrapper1(const emscripten::val& arg1, const emscripten::val& arg2) {
        return cv::dnn::readNetFromCaffe(emscripten::vecFromJSArray<uchar>(arg1), emscripten::vecFromJSArray<uchar>(arg2));
    }
    
    Net readNetFromCaffe_wrapper1_1(const emscripten::val& arg1) {
        return cv::dnn::readNetFromCaffe(emscripten::vecFromJSArray<uchar>(arg1));
    }
    
    Net readNetFromDarknet_wrapper(const std::string& arg1, const std::string& arg2) {
        return cv::dnn::readNetFromDarknet(arg1, arg2);
    }
    
    Net readNetFromDarknet_wrapper_1(const std::string& arg1) {
        return cv::dnn::readNetFromDarknet(arg1);
    }
    
    Net readNetFromDarknet_wrapper1(const emscripten::val& arg1, const emscripten::val& arg2) {
        return cv::dnn::readNetFromDarknet(emscripten::vecFromJSArray<uchar>(arg1), emscripten::vecFromJSArray<uchar>(arg2));
    }
    
    Net readNetFromDarknet_wrapper1_1(const emscripten::val& arg1) {
        return cv::dnn::readNetFromDarknet(emscripten::vecFromJSArray<uchar>(arg1));
    }
    
    Net readNetFromONNX_wrapper(const std::string& arg1) {
        return cv::dnn::readNetFromONNX(arg1);
    }
    
    Net readNetFromONNX_wrapper1(const emscripten::val& arg1) {
        return cv::dnn::readNetFromONNX(emscripten::vecFromJSArray<uchar>(arg1));
    }
    
    Net readNetFromTFLite_wrapper(const std::string& arg1) {
        return cv::dnn::readNetFromTFLite(arg1);
    }
    
    Net readNetFromTFLite_wrapper1(const emscripten::val& arg1) {
        return cv::dnn::readNetFromTFLite(emscripten::vecFromJSArray<uchar>(arg1));
    }
    
    Net readNetFromTensorflow_wrapper(const std::string& arg1, const std::string& arg2) {
        return cv::dnn::readNetFromTensorflow(arg1, arg2);
    }
    
    Net readNetFromTensorflow_wrapper_1(const std::string& arg1) {
        return cv::dnn::readNetFromTensorflow(arg1);
    }
    
    Net readNetFromTensorflow_wrapper1(const emscripten::val& arg1, const emscripten::val& arg2) {
        return cv::dnn::readNetFromTensorflow(emscripten::vecFromJSArray<uchar>(arg1), emscripten::vecFromJSArray<uchar>(arg2));
    }
    
    Net readNetFromTensorflow_wrapper1_1(const emscripten::val& arg1) {
        return cv::dnn::readNetFromTensorflow(emscripten::vecFromJSArray<uchar>(arg1));
    }
    
    Net readNetFromTorch_wrapper(const std::string& arg1, bool arg2, bool arg3) {
        return cv::dnn::readNetFromTorch(arg1, arg2, arg3);
    }
    
    Net readNetFromTorch_wrapper_1(const std::string& arg1, bool arg2) {
        return cv::dnn::readNetFromTorch(arg1, arg2);
    }
    
    Net readNetFromTorch_wrapper_2(const std::string& arg1) {
        return cv::dnn::readNetFromTorch(arg1);
    }
    
    void fisheye_initUndistortRectifyMap_wrapper(const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const Size& arg5, int arg6, cv::Mat& arg7, cv::Mat& arg8) {
        return cv::fisheye::initUndistortRectifyMap(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void fisheye_projectPoints_wrapper(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, const cv::Mat& arg6, double arg7, cv::Mat& arg8) {
        return cv::fisheye::projectPoints(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void fisheye_projectPoints_wrapper_1(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, const cv::Mat& arg6, double arg7) {
        return cv::fisheye::projectPoints(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void fisheye_projectPoints_wrapper_2(const cv::Mat& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4, const cv::Mat& arg5, const cv::Mat& arg6) {
        return cv::fisheye::projectPoints(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper(cv::AKAZE::DescriptorType arg1, int arg2, int arg3, float arg4, int arg5, int arg6, cv::KAZE::DiffusivityType arg7, int arg8) {
        return cv::AKAZE::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_1(cv::AKAZE::DescriptorType arg1, int arg2, int arg3, float arg4, int arg5, int arg6, cv::KAZE::DiffusivityType arg7) {
        return cv::AKAZE::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_2(cv::AKAZE::DescriptorType arg1, int arg2, int arg3, float arg4, int arg5, int arg6) {
        return cv::AKAZE::create(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_3(cv::AKAZE::DescriptorType arg1, int arg2, int arg3, float arg4, int arg5) {
        return cv::AKAZE::create(arg1, arg2, arg3, arg4, arg5);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_4(cv::AKAZE::DescriptorType arg1, int arg2, int arg3, float arg4) {
        return cv::AKAZE::create(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_5(cv::AKAZE::DescriptorType arg1, int arg2, int arg3) {
        return cv::AKAZE::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_6(cv::AKAZE::DescriptorType arg1, int arg2) {
        return cv::AKAZE::create(arg1, arg2);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_7(cv::AKAZE::DescriptorType arg1) {
        return cv::AKAZE::create(arg1);
    }
    
    Ptr<cv::AKAZE> AKAZE_create_wrapper_8() {
        return cv::AKAZE::create();
    }
    
    String AKAZE_getDefaultName_wrapper(cv::AKAZE& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void AKAZE_setDescriptorChannels_wrapper(cv::AKAZE& arg0 , int arg1) {
        return arg0.setDescriptorChannels(arg1);
    }
    
    void AKAZE_setDescriptorSize_wrapper(cv::AKAZE& arg0 , int arg1) {
        return arg0.setDescriptorSize(arg1);
    }
    
    void AKAZE_setDescriptorType_wrapper(cv::AKAZE& arg0 , cv::AKAZE::DescriptorType arg1) {
        return arg0.setDescriptorType(arg1);
    }
    
    void AKAZE_setDiffusivity_wrapper(cv::AKAZE& arg0 , cv::KAZE::DiffusivityType arg1) {
        return arg0.setDiffusivity(arg1);
    }
    
    void AKAZE_setNOctaveLayers_wrapper(cv::AKAZE& arg0 , int arg1) {
        return arg0.setNOctaveLayers(arg1);
    }
    
    void AKAZE_setNOctaves_wrapper(cv::AKAZE& arg0 , int arg1) {
        return arg0.setNOctaves(arg1);
    }
    
    void AKAZE_setThreshold_wrapper(cv::AKAZE& arg0 , double arg1) {
        return arg0.setThreshold(arg1);
    }
    
    Ptr<cv::AgastFeatureDetector> AgastFeatureDetector_create_wrapper(int arg1, bool arg2, cv::AgastFeatureDetector::DetectorType arg3) {
        return cv::AgastFeatureDetector::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::AgastFeatureDetector> AgastFeatureDetector_create_wrapper_1(int arg1, bool arg2) {
        return cv::AgastFeatureDetector::create(arg1, arg2);
    }
    
    Ptr<cv::AgastFeatureDetector> AgastFeatureDetector_create_wrapper_2(int arg1) {
        return cv::AgastFeatureDetector::create(arg1);
    }
    
    Ptr<cv::AgastFeatureDetector> AgastFeatureDetector_create_wrapper_3() {
        return cv::AgastFeatureDetector::create();
    }
    
    String AgastFeatureDetector_getDefaultName_wrapper(cv::AgastFeatureDetector& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void AgastFeatureDetector_setNonmaxSuppression_wrapper(cv::AgastFeatureDetector& arg0 , bool arg1) {
        return arg0.setNonmaxSuppression(arg1);
    }
    
    void AgastFeatureDetector_setThreshold_wrapper(cv::AgastFeatureDetector& arg0 , int arg1) {
        return arg0.setThreshold(arg1);
    }
    
    void AgastFeatureDetector_setType_wrapper(cv::AgastFeatureDetector& arg0 , cv::AgastFeatureDetector::DetectorType arg1) {
        return arg0.setType(arg1);
    }
    
    void AlignExposures_process_wrapper(cv::AlignExposures& arg0 , const std::vector<cv::Mat>& arg1, std::vector<cv::Mat>&& arg2, const cv::Mat& arg3, const cv::Mat& arg4) {
        return arg0.process(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::AlignMTB> _createAlignMTB_wrapper(int arg1, int arg2, bool arg3) {
        return cv::createAlignMTB(arg1, arg2, arg3);
    }
    
    Ptr<cv::AlignMTB> _createAlignMTB_wrapper_1(int arg1, int arg2) {
        return cv::createAlignMTB(arg1, arg2);
    }
    
    Ptr<cv::AlignMTB> _createAlignMTB_wrapper_2(int arg1) {
        return cv::createAlignMTB(arg1);
    }
    
    Ptr<cv::AlignMTB> _createAlignMTB_wrapper_3() {
        return cv::createAlignMTB();
    }
    
    Point AlignMTB_calculateShift_wrapper(cv::AlignMTB& arg0 , const cv::Mat& arg1, const cv::Mat& arg2) {
        return arg0.calculateShift(arg1, arg2);
    }
    
    void AlignMTB_computeBitmaps_wrapper(cv::AlignMTB& arg0 , const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.computeBitmaps(arg1, arg2, arg3);
    }
    
    void AlignMTB_setCut_wrapper(cv::AlignMTB& arg0 , bool arg1) {
        return arg0.setCut(arg1);
    }
    
    void AlignMTB_setExcludeRange_wrapper(cv::AlignMTB& arg0 , int arg1) {
        return arg0.setExcludeRange(arg1);
    }
    
    void AlignMTB_setMaxBits_wrapper(cv::AlignMTB& arg0 , int arg1) {
        return arg0.setMaxBits(arg1);
    }
    
    void AlignMTB_shiftMat_wrapper(cv::AlignMTB& arg0 , const cv::Mat& arg1, cv::Mat& arg2, const Point arg3) {
        return arg0.shiftMat(arg1, arg2, arg3);
    }
    
    Ptr<cv::BFMatcher> BFMatcher_create_wrapper(int arg1, bool arg2) {
        return cv::BFMatcher::create(arg1, arg2);
    }
    
    Ptr<cv::BFMatcher> BFMatcher_create_wrapper_1(int arg1) {
        return cv::BFMatcher::create(arg1);
    }
    
    Ptr<cv::BFMatcher> BFMatcher_create_wrapper_2() {
        return cv::BFMatcher::create();
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper(int arg1, int arg2, float arg3) {
        return cv::BRISK::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper_1(int arg1, int arg2) {
        return cv::BRISK::create(arg1, arg2);
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper_2(int arg1) {
        return cv::BRISK::create(arg1);
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper_3() {
        return cv::BRISK::create();
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper1(const emscripten::val& arg1, const emscripten::val& arg2, float arg3, float arg4, const emscripten::val& arg5) {
        return cv::BRISK::create(emscripten::vecFromJSArray<float>(arg1), emscripten::vecFromJSArray<int>(arg2), arg3, arg4, emscripten::vecFromJSArray<int>(arg5));
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper1_1(const emscripten::val& arg1, const emscripten::val& arg2, float arg3, float arg4) {
        return cv::BRISK::create(emscripten::vecFromJSArray<float>(arg1), emscripten::vecFromJSArray<int>(arg2), arg3, arg4);
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper2(int arg1, int arg2, const emscripten::val& arg3, const emscripten::val& arg4, float arg5, float arg6, const emscripten::val& arg7) {
        return cv::BRISK::create(arg1, arg2, emscripten::vecFromJSArray<float>(arg3), emscripten::vecFromJSArray<int>(arg4), arg5, arg6, emscripten::vecFromJSArray<int>(arg7));
    }
    
    Ptr<cv::BRISK> BRISK_create_wrapper2_1(int arg1, int arg2, const emscripten::val& arg3, const emscripten::val& arg4, float arg5, float arg6) {
        return cv::BRISK::create(arg1, arg2, emscripten::vecFromJSArray<float>(arg3), emscripten::vecFromJSArray<int>(arg4), arg5, arg6);
    }
    
    String BRISK_getDefaultName_wrapper(cv::BRISK& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void BackgroundSubtractor_apply_wrapper(cv::BackgroundSubtractor& arg0 , const cv::Mat& arg1, cv::Mat& arg2, double arg3) {
        return arg0.apply(arg1, arg2, arg3);
    }
    
    void BackgroundSubtractor_apply_wrapper_1(cv::BackgroundSubtractor& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.apply(arg1, arg2);
    }
    
    void BackgroundSubtractor_apply_wrapper1(cv::BackgroundSubtractor& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4) {
        return arg0.apply(arg1, arg2, arg3, arg4);
    }
    
    void BackgroundSubtractor_apply_wrapper1_1(cv::BackgroundSubtractor& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.apply(arg1, arg2, arg3);
    }
    
    void BackgroundSubtractor_getBackgroundImage_wrapper(cv::BackgroundSubtractor& arg0 , cv::Mat& arg1) {
        return arg0.getBackgroundImage(arg1);
    }
    
    Ptr<cv::BackgroundSubtractorMOG2> _createBackgroundSubtractorMOG2_wrapper(int arg1, double arg2, bool arg3) {
        return cv::createBackgroundSubtractorMOG2(arg1, arg2, arg3);
    }
    
    Ptr<cv::BackgroundSubtractorMOG2> _createBackgroundSubtractorMOG2_wrapper_1(int arg1, double arg2) {
        return cv::createBackgroundSubtractorMOG2(arg1, arg2);
    }
    
    Ptr<cv::BackgroundSubtractorMOG2> _createBackgroundSubtractorMOG2_wrapper_2(int arg1) {
        return cv::createBackgroundSubtractorMOG2(arg1);
    }
    
    Ptr<cv::BackgroundSubtractorMOG2> _createBackgroundSubtractorMOG2_wrapper_3() {
        return cv::createBackgroundSubtractorMOG2();
    }
    
    void BackgroundSubtractorMOG2_apply_wrapper(cv::BackgroundSubtractorMOG2& arg0 , const cv::Mat& arg1, cv::Mat& arg2, double arg3) {
        return arg0.apply(arg1, arg2, arg3);
    }
    
    void BackgroundSubtractorMOG2_apply_wrapper_1(cv::BackgroundSubtractorMOG2& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.apply(arg1, arg2);
    }
    
    void BackgroundSubtractorMOG2_apply_wrapper1(cv::BackgroundSubtractorMOG2& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3, double arg4) {
        return arg0.apply(arg1, arg2, arg3, arg4);
    }
    
    void BackgroundSubtractorMOG2_apply_wrapper1_1(cv::BackgroundSubtractorMOG2& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.apply(arg1, arg2, arg3);
    }
    
    Ptr<cv::CLAHE> _createCLAHE_wrapper(double arg1, Size arg2) {
        return cv::createCLAHE(arg1, arg2);
    }
    
    Ptr<cv::CLAHE> _createCLAHE_wrapper_1(double arg1) {
        return cv::createCLAHE(arg1);
    }
    
    Ptr<cv::CLAHE> _createCLAHE_wrapper_2() {
        return cv::createCLAHE();
    }
    
    void CLAHE_apply_wrapper(cv::CLAHE& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.apply(arg1, arg2);
    }
    
    void CLAHE_setClipLimit_wrapper(cv::CLAHE& arg0 , double arg1) {
        return arg0.setClipLimit(arg1);
    }
    
    void CLAHE_setTilesGridSize_wrapper(cv::CLAHE& arg0 , Size arg1) {
        return arg0.setTilesGridSize(arg1);
    }
    
    void CalibrateCRF_process_wrapper(cv::CalibrateCRF& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return arg0.process(arg1, arg2, arg3);
    }
    
    Ptr<cv::CalibrateDebevec> _createCalibrateDebevec_wrapper(int arg1, float arg2, bool arg3) {
        return cv::createCalibrateDebevec(arg1, arg2, arg3);
    }
    
    Ptr<cv::CalibrateDebevec> _createCalibrateDebevec_wrapper_1(int arg1, float arg2) {
        return cv::createCalibrateDebevec(arg1, arg2);
    }
    
    Ptr<cv::CalibrateDebevec> _createCalibrateDebevec_wrapper_2(int arg1) {
        return cv::createCalibrateDebevec(arg1);
    }
    
    Ptr<cv::CalibrateDebevec> _createCalibrateDebevec_wrapper_3() {
        return cv::createCalibrateDebevec();
    }
    
    void CalibrateDebevec_setLambda_wrapper(cv::CalibrateDebevec& arg0 , float arg1) {
        return arg0.setLambda(arg1);
    }
    
    void CalibrateDebevec_setRandom_wrapper(cv::CalibrateDebevec& arg0 , bool arg1) {
        return arg0.setRandom(arg1);
    }
    
    void CalibrateDebevec_setSamples_wrapper(cv::CalibrateDebevec& arg0 , int arg1) {
        return arg0.setSamples(arg1);
    }
    
    Ptr<cv::CalibrateRobertson> _createCalibrateRobertson_wrapper(int arg1, float arg2) {
        return cv::createCalibrateRobertson(arg1, arg2);
    }
    
    Ptr<cv::CalibrateRobertson> _createCalibrateRobertson_wrapper_1(int arg1) {
        return cv::createCalibrateRobertson(arg1);
    }
    
    Ptr<cv::CalibrateRobertson> _createCalibrateRobertson_wrapper_2() {
        return cv::createCalibrateRobertson();
    }
    
    void CalibrateRobertson_setMaxIter_wrapper(cv::CalibrateRobertson& arg0 , int arg1) {
        return arg0.setMaxIter(arg1);
    }
    
    void CalibrateRobertson_setThreshold_wrapper(cv::CalibrateRobertson& arg0 , float arg1) {
        return arg0.setThreshold(arg1);
    }
    
    void CascadeClassifier_detectMultiScale_wrapper(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, double arg3, int arg4, int arg5, Size arg6, Size arg7) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void CascadeClassifier_detectMultiScale_wrapper_1(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, double arg3, int arg4, int arg5, Size arg6) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void CascadeClassifier_detectMultiScale_wrapper_2(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, double arg3, int arg4, int arg5) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5);
    }
    
    void CascadeClassifier_detectMultiScale_wrapper_3(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, double arg3, int arg4) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4);
    }
    
    void CascadeClassifier_detectMultiScale_wrapper_4(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, double arg3) {
        return arg0.detectMultiScale(arg1, arg2, arg3);
    }
    
    void CascadeClassifier_detectMultiScale_wrapper_5(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2) {
        return arg0.detectMultiScale(arg1, arg2);
    }
    
    void CascadeClassifier_detectMultiScale2_wrapper(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, double arg4, int arg5, int arg6, Size arg7, Size arg8) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void CascadeClassifier_detectMultiScale2_wrapper_1(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, double arg4, int arg5, int arg6, Size arg7) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void CascadeClassifier_detectMultiScale2_wrapper_2(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, double arg4, int arg5, int arg6) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void CascadeClassifier_detectMultiScale2_wrapper_3(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, double arg4, int arg5) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5);
    }
    
    void CascadeClassifier_detectMultiScale2_wrapper_4(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, double arg4) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4);
    }
    
    void CascadeClassifier_detectMultiScale2_wrapper_5(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3) {
        return arg0.detectMultiScale(arg1, arg2, arg3);
    }
    
    void CascadeClassifier_detectMultiScale3_wrapper(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, std::vector<double>& arg4, double arg5, int arg6, int arg7, Size arg8, Size arg9, bool arg10) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10);
    }
    
    void CascadeClassifier_detectMultiScale3_wrapper_1(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, std::vector<double>& arg4, double arg5, int arg6, int arg7, Size arg8, Size arg9) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void CascadeClassifier_detectMultiScale3_wrapper_2(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, std::vector<double>& arg4, double arg5, int arg6, int arg7, Size arg8) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void CascadeClassifier_detectMultiScale3_wrapper_3(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, std::vector<double>& arg4, double arg5, int arg6, int arg7) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void CascadeClassifier_detectMultiScale3_wrapper_4(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, std::vector<double>& arg4, double arg5, int arg6) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void CascadeClassifier_detectMultiScale3_wrapper_5(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, std::vector<double>& arg4, double arg5) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5);
    }
    
    void CascadeClassifier_detectMultiScale3_wrapper_6(cv::CascadeClassifier& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<int>& arg3, std::vector<double>& arg4) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4);
    }
    
    bool CascadeClassifier_load_wrapper(cv::CascadeClassifier& arg0 , const std::string& arg1) {
        return arg0.load(arg1);
    }
    
    void DescriptorMatcher_add_wrapper(cv::DescriptorMatcher& arg0 , const std::vector<cv::Mat>& arg1) {
        return arg0.add(arg1);
    }
    
    Ptr<cv::DescriptorMatcher> DescriptorMatcher_create_wrapper(const std::string& arg1) {
        return cv::DescriptorMatcher::create(arg1);
    }
    
    void DescriptorMatcher_knnMatch_wrapper(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<std::vector<DMatch>>& arg3, int arg4, const cv::Mat& arg5, bool arg6) {
        return arg0.knnMatch(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void DescriptorMatcher_knnMatch_wrapper_1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<std::vector<DMatch>>& arg3, int arg4, const cv::Mat& arg5) {
        return arg0.knnMatch(arg1, arg2, arg3, arg4, arg5);
    }
    
    void DescriptorMatcher_knnMatch_wrapper_2(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<std::vector<DMatch>>& arg3, int arg4) {
        return arg0.knnMatch(arg1, arg2, arg3, arg4);
    }
    
    void DescriptorMatcher_knnMatch_wrapper1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<std::vector<DMatch>>& arg2, int arg3, const std::vector<cv::Mat>& arg4, bool arg5) {
        return arg0.knnMatch(arg1, arg2, arg3, arg4, arg5);
    }
    
    void DescriptorMatcher_knnMatch_wrapper1_1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<std::vector<DMatch>>& arg2, int arg3, const std::vector<cv::Mat>& arg4) {
        return arg0.knnMatch(arg1, arg2, arg3, arg4);
    }
    
    void DescriptorMatcher_knnMatch_wrapper1_2(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<std::vector<DMatch>>& arg2, int arg3) {
        return arg0.knnMatch(arg1, arg2, arg3);
    }
    
    void DescriptorMatcher_match_wrapper(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<DMatch>& arg3, const cv::Mat& arg4) {
        return arg0.match(arg1, arg2, arg3, arg4);
    }
    
    void DescriptorMatcher_match_wrapper_1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<DMatch>& arg3) {
        return arg0.match(arg1, arg2, arg3);
    }
    
    void DescriptorMatcher_match_wrapper1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<DMatch>& arg2, const std::vector<cv::Mat>& arg3) {
        return arg0.match(arg1, arg2, arg3);
    }
    
    void DescriptorMatcher_match_wrapper1_1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<DMatch>& arg2) {
        return arg0.match(arg1, arg2);
    }
    
    void DescriptorMatcher_radiusMatch_wrapper(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<std::vector<DMatch>>& arg3, float arg4, const cv::Mat& arg5, bool arg6) {
        return arg0.radiusMatch(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void DescriptorMatcher_radiusMatch_wrapper_1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<std::vector<DMatch>>& arg3, float arg4, const cv::Mat& arg5) {
        return arg0.radiusMatch(arg1, arg2, arg3, arg4, arg5);
    }
    
    void DescriptorMatcher_radiusMatch_wrapper_2(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<std::vector<DMatch>>& arg3, float arg4) {
        return arg0.radiusMatch(arg1, arg2, arg3, arg4);
    }
    
    void DescriptorMatcher_radiusMatch_wrapper1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<std::vector<DMatch>>& arg2, float arg3, const std::vector<cv::Mat>& arg4, bool arg5) {
        return arg0.radiusMatch(arg1, arg2, arg3, arg4, arg5);
    }
    
    void DescriptorMatcher_radiusMatch_wrapper1_1(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<std::vector<DMatch>>& arg2, float arg3, const std::vector<cv::Mat>& arg4) {
        return arg0.radiusMatch(arg1, arg2, arg3, arg4);
    }
    
    void DescriptorMatcher_radiusMatch_wrapper1_2(cv::DescriptorMatcher& arg0 , const cv::Mat& arg1, std::vector<std::vector<DMatch>>& arg2, float arg3) {
        return arg0.radiusMatch(arg1, arg2, arg3);
    }
    
    Ptr<cv::FaceDetectorYN> FaceDetectorYN_create_wrapper(const std::string& arg1, const std::string& arg2, const Size& arg3, float arg4, float arg5, int arg6, int arg7, int arg8) {
        return cv::FaceDetectorYN::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    Ptr<cv::FaceDetectorYN> FaceDetectorYN_create_wrapper_1(const std::string& arg1, const std::string& arg2, const Size& arg3, float arg4, float arg5, int arg6, int arg7) {
        return cv::FaceDetectorYN::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    Ptr<cv::FaceDetectorYN> FaceDetectorYN_create_wrapper_2(const std::string& arg1, const std::string& arg2, const Size& arg3, float arg4, float arg5, int arg6) {
        return cv::FaceDetectorYN::create(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::FaceDetectorYN> FaceDetectorYN_create_wrapper_3(const std::string& arg1, const std::string& arg2, const Size& arg3, float arg4, float arg5) {
        return cv::FaceDetectorYN::create(arg1, arg2, arg3, arg4, arg5);
    }
    
    Ptr<cv::FaceDetectorYN> FaceDetectorYN_create_wrapper_4(const std::string& arg1, const std::string& arg2, const Size& arg3, float arg4) {
        return cv::FaceDetectorYN::create(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::FaceDetectorYN> FaceDetectorYN_create_wrapper_5(const std::string& arg1, const std::string& arg2, const Size& arg3) {
        return cv::FaceDetectorYN::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::FaceDetectorYN> FaceDetectorYN_create_wrapper1(const std::string& arg1, const emscripten::val& arg2, const emscripten::val& arg3, const Size& arg4, float arg5, float arg6, int arg7, int arg8, int arg9) {
        return cv::FaceDetectorYN::create(arg1, emscripten::vecFromJSArray<uchar>(arg2), emscripten::vecFromJSArray<uchar>(arg3), arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    int FaceDetectorYN_detect_wrapper(cv::FaceDetectorYN& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.detect(arg1, arg2);
    }
    
    void FaceDetectorYN_setInputSize_wrapper(cv::FaceDetectorYN& arg0 , const Size& arg1) {
        return arg0.setInputSize(arg1);
    }
    
    void FaceDetectorYN_setNMSThreshold_wrapper(cv::FaceDetectorYN& arg0 , float arg1) {
        return arg0.setNMSThreshold(arg1);
    }
    
    void FaceDetectorYN_setScoreThreshold_wrapper(cv::FaceDetectorYN& arg0 , float arg1) {
        return arg0.setScoreThreshold(arg1);
    }
    
    void FaceDetectorYN_setTopK_wrapper(cv::FaceDetectorYN& arg0 , int arg1) {
        return arg0.setTopK(arg1);
    }
    
    Ptr<cv::FastFeatureDetector> FastFeatureDetector_create_wrapper(int arg1, bool arg2, cv::FastFeatureDetector::DetectorType arg3) {
        return cv::FastFeatureDetector::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::FastFeatureDetector> FastFeatureDetector_create_wrapper_1(int arg1, bool arg2) {
        return cv::FastFeatureDetector::create(arg1, arg2);
    }
    
    Ptr<cv::FastFeatureDetector> FastFeatureDetector_create_wrapper_2(int arg1) {
        return cv::FastFeatureDetector::create(arg1);
    }
    
    Ptr<cv::FastFeatureDetector> FastFeatureDetector_create_wrapper_3() {
        return cv::FastFeatureDetector::create();
    }
    
    String FastFeatureDetector_getDefaultName_wrapper(cv::FastFeatureDetector& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void FastFeatureDetector_setNonmaxSuppression_wrapper(cv::FastFeatureDetector& arg0 , bool arg1) {
        return arg0.setNonmaxSuppression(arg1);
    }
    
    void FastFeatureDetector_setThreshold_wrapper(cv::FastFeatureDetector& arg0 , int arg1) {
        return arg0.setThreshold(arg1);
    }
    
    void FastFeatureDetector_setType_wrapper(cv::FastFeatureDetector& arg0 , cv::FastFeatureDetector::DetectorType arg1) {
        return arg0.setType(arg1);
    }
    
    void Feature2D_compute_wrapper(cv::Feature2D& arg0 , const cv::Mat& arg1, std::vector<KeyPoint>& arg2, cv::Mat& arg3) {
        return arg0.compute(arg1, arg2, arg3);
    }
    
    void Feature2D_compute_wrapper1(cv::Feature2D& arg0 , const std::vector<cv::Mat>& arg1, std::vector<std::vector<KeyPoint>>& arg2, std::vector<cv::Mat>& arg3) {
        return arg0.compute(arg1, arg2, arg3);
    }
    
    void Feature2D_detect_wrapper(cv::Feature2D& arg0 , const cv::Mat& arg1, std::vector<KeyPoint>& arg2, const cv::Mat& arg3) {
        return arg0.detect(arg1, arg2, arg3);
    }
    
    void Feature2D_detect_wrapper_1(cv::Feature2D& arg0 , const cv::Mat& arg1, std::vector<KeyPoint>& arg2) {
        return arg0.detect(arg1, arg2);
    }
    
    void Feature2D_detect_wrapper1(cv::Feature2D& arg0 , const std::vector<cv::Mat>& arg1, std::vector<std::vector<KeyPoint>>& arg2, const std::vector<cv::Mat>& arg3) {
        return arg0.detect(arg1, arg2, arg3);
    }
    
    void Feature2D_detect_wrapper1_1(cv::Feature2D& arg0 , const std::vector<cv::Mat>& arg1, std::vector<std::vector<KeyPoint>>& arg2) {
        return arg0.detect(arg1, arg2);
    }
    
    void Feature2D_detectAndCompute_wrapper(cv::Feature2D& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<KeyPoint>& arg3, cv::Mat& arg4, bool arg5) {
        return arg0.detectAndCompute(arg1, arg2, arg3, arg4, arg5);
    }
    
    void Feature2D_detectAndCompute_wrapper_1(cv::Feature2D& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<KeyPoint>& arg3, cv::Mat& arg4) {
        return arg0.detectAndCompute(arg1, arg2, arg3, arg4);
    }
    
    String Feature2D_getDefaultName_wrapper(cv::Feature2D& arg0 ) {
        return arg0.getDefaultName();
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper(int arg1, double arg2, double arg3, int arg4, bool arg5, double arg6) {
        return cv::GFTTDetector::create(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper_1(int arg1, double arg2, double arg3, int arg4, bool arg5) {
        return cv::GFTTDetector::create(arg1, arg2, arg3, arg4, arg5);
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper_2(int arg1, double arg2, double arg3, int arg4) {
        return cv::GFTTDetector::create(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper_3(int arg1, double arg2, double arg3) {
        return cv::GFTTDetector::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper_4(int arg1, double arg2) {
        return cv::GFTTDetector::create(arg1, arg2);
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper_5(int arg1) {
        return cv::GFTTDetector::create(arg1);
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper_6() {
        return cv::GFTTDetector::create();
    }
    
    Ptr<cv::GFTTDetector> GFTTDetector_create_wrapper1(int arg1, double arg2, double arg3, int arg4, int arg5, bool arg6, double arg7) {
        return cv::GFTTDetector::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    String GFTTDetector_getDefaultName_wrapper(cv::GFTTDetector& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void GFTTDetector_setBlockSize_wrapper(cv::GFTTDetector& arg0 , int arg1) {
        return arg0.setBlockSize(arg1);
    }
    
    void GFTTDetector_setHarrisDetector_wrapper(cv::GFTTDetector& arg0 , bool arg1) {
        return arg0.setHarrisDetector(arg1);
    }
    
    void GFTTDetector_setK_wrapper(cv::GFTTDetector& arg0 , double arg1) {
        return arg0.setK(arg1);
    }
    
    void GFTTDetector_setMaxFeatures_wrapper(cv::GFTTDetector& arg0 , int arg1) {
        return arg0.setMaxFeatures(arg1);
    }
    
    void GFTTDetector_setMinDistance_wrapper(cv::GFTTDetector& arg0 , double arg1) {
        return arg0.setMinDistance(arg1);
    }
    
    void GFTTDetector_setQualityLevel_wrapper(cv::GFTTDetector& arg0 , double arg1) {
        return arg0.setQualityLevel(arg1);
    }
    
    string GraphicalCodeDetector_decode_wrapper(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.decode(arg1, arg2, arg3);
    }
    
    string GraphicalCodeDetector_decode_wrapper_1(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, const cv::Mat& arg2) {
        return arg0.decode(arg1, arg2);
    }
    
    bool GraphicalCodeDetector_decodeMulti_wrapper(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<string>& arg3, std::vector<cv::Mat>& arg4) {
        return arg0.decodeMulti(arg1, arg2, arg3, arg4);
    }
    
    bool GraphicalCodeDetector_decodeMulti_wrapper_1(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<string>& arg3) {
        return arg0.decodeMulti(arg1, arg2, arg3);
    }
    
    bool GraphicalCodeDetector_detect_wrapper(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.detect(arg1, arg2);
    }
    
    string GraphicalCodeDetector_detectAndDecode_wrapper(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.detectAndDecode(arg1, arg2, arg3);
    }
    
    string GraphicalCodeDetector_detectAndDecode_wrapper_1(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.detectAndDecode(arg1, arg2);
    }
    
    string GraphicalCodeDetector_detectAndDecode_wrapper_2(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1) {
        return arg0.detectAndDecode(arg1);
    }
    
    bool GraphicalCodeDetector_detectAndDecodeMulti_wrapper(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, std::vector<string>& arg2, cv::Mat& arg3, std::vector<cv::Mat>& arg4) {
        return arg0.detectAndDecodeMulti(arg1, arg2, arg3, arg4);
    }
    
    bool GraphicalCodeDetector_detectAndDecodeMulti_wrapper_1(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, std::vector<string>& arg2, cv::Mat& arg3) {
        return arg0.detectAndDecodeMulti(arg1, arg2, arg3);
    }
    
    bool GraphicalCodeDetector_detectAndDecodeMulti_wrapper_2(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, std::vector<string>& arg2) {
        return arg0.detectAndDecodeMulti(arg1, arg2);
    }
    
    bool GraphicalCodeDetector_detectMulti_wrapper(cv::GraphicalCodeDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.detectMulti(arg1, arg2);
    }
    
    void HOGDescriptor_detectMultiScale_wrapper(cv::HOGDescriptor& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<double>& arg3, double arg4, Size arg5, Size arg6, double arg7, double arg8, bool arg9) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    void HOGDescriptor_detectMultiScale_wrapper_1(cv::HOGDescriptor& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<double>& arg3, double arg4, Size arg5, Size arg6, double arg7, double arg8) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void HOGDescriptor_detectMultiScale_wrapper_2(cv::HOGDescriptor& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<double>& arg3, double arg4, Size arg5, Size arg6, double arg7) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void HOGDescriptor_detectMultiScale_wrapper_3(cv::HOGDescriptor& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<double>& arg3, double arg4, Size arg5, Size arg6) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void HOGDescriptor_detectMultiScale_wrapper_4(cv::HOGDescriptor& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<double>& arg3, double arg4, Size arg5) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4, arg5);
    }
    
    void HOGDescriptor_detectMultiScale_wrapper_5(cv::HOGDescriptor& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<double>& arg3, double arg4) {
        return arg0.detectMultiScale(arg1, arg2, arg3, arg4);
    }
    
    void HOGDescriptor_detectMultiScale_wrapper_6(cv::HOGDescriptor& arg0 , const cv::Mat& arg1, std::vector<Rect>& arg2, std::vector<double>& arg3) {
        return arg0.detectMultiScale(arg1, arg2, arg3);
    }
    
    bool HOGDescriptor_load_wrapper(cv::HOGDescriptor& arg0 , const std::string& arg1, const std::string& arg2) {
        return arg0.load(arg1, arg2);
    }
    
    bool HOGDescriptor_load_wrapper_1(cv::HOGDescriptor& arg0 , const std::string& arg1) {
        return arg0.load(arg1);
    }
    
    void HOGDescriptor_setSVMDetector_wrapper(cv::HOGDescriptor& arg0 , const cv::Mat& arg1) {
        return arg0.setSVMDetector(arg1);
    }
    
    Ptr<cv::KAZE> KAZE_create_wrapper(bool arg1, bool arg2, float arg3, int arg4, int arg5, cv::KAZE::DiffusivityType arg6) {
        return cv::KAZE::create(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::KAZE> KAZE_create_wrapper_1(bool arg1, bool arg2, float arg3, int arg4, int arg5) {
        return cv::KAZE::create(arg1, arg2, arg3, arg4, arg5);
    }
    
    Ptr<cv::KAZE> KAZE_create_wrapper_2(bool arg1, bool arg2, float arg3, int arg4) {
        return cv::KAZE::create(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::KAZE> KAZE_create_wrapper_3(bool arg1, bool arg2, float arg3) {
        return cv::KAZE::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::KAZE> KAZE_create_wrapper_4(bool arg1, bool arg2) {
        return cv::KAZE::create(arg1, arg2);
    }
    
    Ptr<cv::KAZE> KAZE_create_wrapper_5(bool arg1) {
        return cv::KAZE::create(arg1);
    }
    
    Ptr<cv::KAZE> KAZE_create_wrapper_6() {
        return cv::KAZE::create();
    }
    
    String KAZE_getDefaultName_wrapper(cv::KAZE& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void KAZE_setDiffusivity_wrapper(cv::KAZE& arg0 , cv::KAZE::DiffusivityType arg1) {
        return arg0.setDiffusivity(arg1);
    }
    
    void KAZE_setExtended_wrapper(cv::KAZE& arg0 , bool arg1) {
        return arg0.setExtended(arg1);
    }
    
    void KAZE_setNOctaveLayers_wrapper(cv::KAZE& arg0 , int arg1) {
        return arg0.setNOctaveLayers(arg1);
    }
    
    void KAZE_setNOctaves_wrapper(cv::KAZE& arg0 , int arg1) {
        return arg0.setNOctaves(arg1);
    }
    
    void KAZE_setThreshold_wrapper(cv::KAZE& arg0 , double arg1) {
        return arg0.setThreshold(arg1);
    }
    
    void KAZE_setUpright_wrapper(cv::KAZE& arg0 , bool arg1) {
        return arg0.setUpright(arg1);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper(int arg1, int arg2, int arg3, double arg4, double arg5, int arg6, double arg7, double arg8, int arg9) {
        return cv::MSER::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_1(int arg1, int arg2, int arg3, double arg4, double arg5, int arg6, double arg7, double arg8) {
        return cv::MSER::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_2(int arg1, int arg2, int arg3, double arg4, double arg5, int arg6, double arg7) {
        return cv::MSER::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_3(int arg1, int arg2, int arg3, double arg4, double arg5, int arg6) {
        return cv::MSER::create(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_4(int arg1, int arg2, int arg3, double arg4, double arg5) {
        return cv::MSER::create(arg1, arg2, arg3, arg4, arg5);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_5(int arg1, int arg2, int arg3, double arg4) {
        return cv::MSER::create(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_6(int arg1, int arg2, int arg3) {
        return cv::MSER::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_7(int arg1, int arg2) {
        return cv::MSER::create(arg1, arg2);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_8(int arg1) {
        return cv::MSER::create(arg1);
    }
    
    Ptr<cv::MSER> MSER_create_wrapper_9() {
        return cv::MSER::create();
    }
    
    void MSER_detectRegions_wrapper(cv::MSER& arg0 , const cv::Mat& arg1, std::vector<std::vector<Point>>& arg2, std::vector<Rect>& arg3) {
        return arg0.detectRegions(arg1, arg2, arg3);
    }
    
    String MSER_getDefaultName_wrapper(cv::MSER& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void MSER_setDelta_wrapper(cv::MSER& arg0 , int arg1) {
        return arg0.setDelta(arg1);
    }
    
    void MSER_setMaxArea_wrapper(cv::MSER& arg0 , int arg1) {
        return arg0.setMaxArea(arg1);
    }
    
    void MSER_setMinArea_wrapper(cv::MSER& arg0 , int arg1) {
        return arg0.setMinArea(arg1);
    }
    
    void MSER_setPass2Only_wrapper(cv::MSER& arg0 , bool arg1) {
        return arg0.setPass2Only(arg1);
    }
    
    void MergeDebevec_process_wrapper(cv::MergeDebevec& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4) {
        return arg0.process(arg1, arg2, arg3, arg4);
    }
    
    void MergeDebevec_process_wrapper1(cv::MergeDebevec& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return arg0.process(arg1, arg2, arg3);
    }
    
    void MergeExposures_process_wrapper(cv::MergeExposures& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4) {
        return arg0.process(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::MergeMertens> _createMergeMertens_wrapper(float arg1, float arg2, float arg3) {
        return cv::createMergeMertens(arg1, arg2, arg3);
    }
    
    Ptr<cv::MergeMertens> _createMergeMertens_wrapper_1(float arg1, float arg2) {
        return cv::createMergeMertens(arg1, arg2);
    }
    
    Ptr<cv::MergeMertens> _createMergeMertens_wrapper_2(float arg1) {
        return cv::createMergeMertens(arg1);
    }
    
    Ptr<cv::MergeMertens> _createMergeMertens_wrapper_3() {
        return cv::createMergeMertens();
    }
    
    void MergeMertens_process_wrapper(cv::MergeMertens& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4) {
        return arg0.process(arg1, arg2, arg3, arg4);
    }
    
    void MergeMertens_process_wrapper1(cv::MergeMertens& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2) {
        return arg0.process(arg1, arg2);
    }
    
    void MergeMertens_setContrastWeight_wrapper(cv::MergeMertens& arg0 , float arg1) {
        return arg0.setContrastWeight(arg1);
    }
    
    void MergeMertens_setExposureWeight_wrapper(cv::MergeMertens& arg0 , float arg1) {
        return arg0.setExposureWeight(arg1);
    }
    
    void MergeMertens_setSaturationWeight_wrapper(cv::MergeMertens& arg0 , float arg1) {
        return arg0.setSaturationWeight(arg1);
    }
    
    void MergeRobertson_process_wrapper(cv::MergeRobertson& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4) {
        return arg0.process(arg1, arg2, arg3, arg4);
    }
    
    void MergeRobertson_process_wrapper1(cv::MergeRobertson& arg0 , const std::vector<cv::Mat>& arg1, cv::Mat& arg2, const cv::Mat& arg3) {
        return arg0.process(arg1, arg2, arg3);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper(int arg1, float arg2, int arg3, int arg4, int arg5, int arg6, cv::ORB::ScoreType arg7, int arg8, int arg9) {
        return cv::ORB::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_1(int arg1, float arg2, int arg3, int arg4, int arg5, int arg6, cv::ORB::ScoreType arg7, int arg8) {
        return cv::ORB::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_2(int arg1, float arg2, int arg3, int arg4, int arg5, int arg6, cv::ORB::ScoreType arg7) {
        return cv::ORB::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_3(int arg1, float arg2, int arg3, int arg4, int arg5, int arg6) {
        return cv::ORB::create(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_4(int arg1, float arg2, int arg3, int arg4, int arg5) {
        return cv::ORB::create(arg1, arg2, arg3, arg4, arg5);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_5(int arg1, float arg2, int arg3, int arg4) {
        return cv::ORB::create(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_6(int arg1, float arg2, int arg3) {
        return cv::ORB::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_7(int arg1, float arg2) {
        return cv::ORB::create(arg1, arg2);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_8(int arg1) {
        return cv::ORB::create(arg1);
    }
    
    Ptr<cv::ORB> ORB_create_wrapper_9() {
        return cv::ORB::create();
    }
    
    String ORB_getDefaultName_wrapper(cv::ORB& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void ORB_setEdgeThreshold_wrapper(cv::ORB& arg0 , int arg1) {
        return arg0.setEdgeThreshold(arg1);
    }
    
    void ORB_setFastThreshold_wrapper(cv::ORB& arg0 , int arg1) {
        return arg0.setFastThreshold(arg1);
    }
    
    void ORB_setFirstLevel_wrapper(cv::ORB& arg0 , int arg1) {
        return arg0.setFirstLevel(arg1);
    }
    
    void ORB_setMaxFeatures_wrapper(cv::ORB& arg0 , int arg1) {
        return arg0.setMaxFeatures(arg1);
    }
    
    void ORB_setNLevels_wrapper(cv::ORB& arg0 , int arg1) {
        return arg0.setNLevels(arg1);
    }
    
    void ORB_setPatchSize_wrapper(cv::ORB& arg0 , int arg1) {
        return arg0.setPatchSize(arg1);
    }
    
    void ORB_setScaleFactor_wrapper(cv::ORB& arg0 , double arg1) {
        return arg0.setScaleFactor(arg1);
    }
    
    void ORB_setScoreType_wrapper(cv::ORB& arg0 , cv::ORB::ScoreType arg1) {
        return arg0.setScoreType(arg1);
    }
    
    void ORB_setWTA_K_wrapper(cv::ORB& arg0 , int arg1) {
        return arg0.setWTA_K(arg1);
    }
    
    String QRCodeDetector_decodeCurved_wrapper(cv::QRCodeDetector& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.decodeCurved(arg1, arg2, arg3);
    }
    
    String QRCodeDetector_decodeCurved_wrapper_1(cv::QRCodeDetector& arg0 , const cv::Mat& arg1, const cv::Mat& arg2) {
        return arg0.decodeCurved(arg1, arg2);
    }
    
    string QRCodeDetector_detectAndDecodeCurved_wrapper(cv::QRCodeDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.detectAndDecodeCurved(arg1, arg2, arg3);
    }
    
    string QRCodeDetector_detectAndDecodeCurved_wrapper_1(cv::QRCodeDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.detectAndDecodeCurved(arg1, arg2);
    }
    
    string QRCodeDetector_detectAndDecodeCurved_wrapper_2(cv::QRCodeDetector& arg0 , const cv::Mat& arg1) {
        return arg0.detectAndDecodeCurved(arg1);
    }
    
    QRCodeDetector QRCodeDetector_setEpsX_wrapper(cv::QRCodeDetector& arg0 , double arg1) {
        return arg0.setEpsX(arg1);
    }
    
    QRCodeDetector QRCodeDetector_setEpsY_wrapper(cv::QRCodeDetector& arg0 , double arg1) {
        return arg0.setEpsY(arg1);
    }
    
    void QRCodeDetectorAruco_setArucoParameters_wrapper(cv::QRCodeDetectorAruco& arg0 , const aruco_DetectorParameters& arg1) {
        return arg0.setArucoParameters(arg1);
    }
    
    QRCodeDetectorAruco QRCodeDetectorAruco_setDetectorParameters_wrapper(cv::QRCodeDetectorAruco& arg0 , const QRCodeDetectorAruco_Params& arg1) {
        return arg0.setDetectorParameters(arg1);
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper(int arg1, int arg2, double arg3, double arg4, double arg5, bool arg6) {
        return cv::SIFT::create(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper_1(int arg1, int arg2, double arg3, double arg4, double arg5) {
        return cv::SIFT::create(arg1, arg2, arg3, arg4, arg5);
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper_2(int arg1, int arg2, double arg3, double arg4) {
        return cv::SIFT::create(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper_3(int arg1, int arg2, double arg3) {
        return cv::SIFT::create(arg1, arg2, arg3);
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper_4(int arg1, int arg2) {
        return cv::SIFT::create(arg1, arg2);
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper_5(int arg1) {
        return cv::SIFT::create(arg1);
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper_6() {
        return cv::SIFT::create();
    }
    
    Ptr<cv::SIFT> SIFT_create_wrapper1(int arg1, int arg2, double arg3, double arg4, double arg5, int arg6, bool arg7) {
        return cv::SIFT::create(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    String SIFT_getDefaultName_wrapper(cv::SIFT& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void SIFT_setContrastThreshold_wrapper(cv::SIFT& arg0 , double arg1) {
        return arg0.setContrastThreshold(arg1);
    }
    
    void SIFT_setEdgeThreshold_wrapper(cv::SIFT& arg0 , double arg1) {
        return arg0.setEdgeThreshold(arg1);
    }
    
    void SIFT_setNFeatures_wrapper(cv::SIFT& arg0 , int arg1) {
        return arg0.setNFeatures(arg1);
    }
    
    void SIFT_setNOctaveLayers_wrapper(cv::SIFT& arg0 , int arg1) {
        return arg0.setNOctaveLayers(arg1);
    }
    
    void SIFT_setSigma_wrapper(cv::SIFT& arg0 , double arg1) {
        return arg0.setSigma(arg1);
    }
    
    Ptr<cv::SimpleBlobDetector> SimpleBlobDetector_create_wrapper(const SimpleBlobDetector_Params& arg1) {
        return cv::SimpleBlobDetector::create(arg1);
    }
    
    Ptr<cv::SimpleBlobDetector> SimpleBlobDetector_create_wrapper_1() {
        return cv::SimpleBlobDetector::create();
    }
    
    String SimpleBlobDetector_getDefaultName_wrapper(cv::SimpleBlobDetector& arg0 ) {
        return arg0.getDefaultName();
    }
    
    void SimpleBlobDetector_setParams_wrapper(cv::SimpleBlobDetector& arg0 , const SimpleBlobDetector_Params& arg1) {
        return arg0.setParams(arg1);
    }
    
    void Tonemap_process_wrapper(cv::Tonemap& arg0 , const cv::Mat& arg1, cv::Mat& arg2) {
        return arg0.process(arg1, arg2);
    }
    
    void Tonemap_setGamma_wrapper(cv::Tonemap& arg0 , float arg1) {
        return arg0.setGamma(arg1);
    }
    
    Ptr<cv::TonemapDrago> _createTonemapDrago_wrapper(float arg1, float arg2, float arg3) {
        return cv::createTonemapDrago(arg1, arg2, arg3);
    }
    
    Ptr<cv::TonemapDrago> _createTonemapDrago_wrapper_1(float arg1, float arg2) {
        return cv::createTonemapDrago(arg1, arg2);
    }
    
    Ptr<cv::TonemapDrago> _createTonemapDrago_wrapper_2(float arg1) {
        return cv::createTonemapDrago(arg1);
    }
    
    Ptr<cv::TonemapDrago> _createTonemapDrago_wrapper_3() {
        return cv::createTonemapDrago();
    }
    
    void TonemapDrago_setBias_wrapper(cv::TonemapDrago& arg0 , float arg1) {
        return arg0.setBias(arg1);
    }
    
    void TonemapDrago_setSaturation_wrapper(cv::TonemapDrago& arg0 , float arg1) {
        return arg0.setSaturation(arg1);
    }
    
    Ptr<cv::TonemapMantiuk> _createTonemapMantiuk_wrapper(float arg1, float arg2, float arg3) {
        return cv::createTonemapMantiuk(arg1, arg2, arg3);
    }
    
    Ptr<cv::TonemapMantiuk> _createTonemapMantiuk_wrapper_1(float arg1, float arg2) {
        return cv::createTonemapMantiuk(arg1, arg2);
    }
    
    Ptr<cv::TonemapMantiuk> _createTonemapMantiuk_wrapper_2(float arg1) {
        return cv::createTonemapMantiuk(arg1);
    }
    
    Ptr<cv::TonemapMantiuk> _createTonemapMantiuk_wrapper_3() {
        return cv::createTonemapMantiuk();
    }
    
    void TonemapMantiuk_setSaturation_wrapper(cv::TonemapMantiuk& arg0 , float arg1) {
        return arg0.setSaturation(arg1);
    }
    
    void TonemapMantiuk_setScale_wrapper(cv::TonemapMantiuk& arg0 , float arg1) {
        return arg0.setScale(arg1);
    }
    
    Ptr<cv::TonemapReinhard> _createTonemapReinhard_wrapper(float arg1, float arg2, float arg3, float arg4) {
        return cv::createTonemapReinhard(arg1, arg2, arg3, arg4);
    }
    
    Ptr<cv::TonemapReinhard> _createTonemapReinhard_wrapper_1(float arg1, float arg2, float arg3) {
        return cv::createTonemapReinhard(arg1, arg2, arg3);
    }
    
    Ptr<cv::TonemapReinhard> _createTonemapReinhard_wrapper_2(float arg1, float arg2) {
        return cv::createTonemapReinhard(arg1, arg2);
    }
    
    Ptr<cv::TonemapReinhard> _createTonemapReinhard_wrapper_3(float arg1) {
        return cv::createTonemapReinhard(arg1);
    }
    
    Ptr<cv::TonemapReinhard> _createTonemapReinhard_wrapper_4() {
        return cv::createTonemapReinhard();
    }
    
    void TonemapReinhard_setColorAdaptation_wrapper(cv::TonemapReinhard& arg0 , float arg1) {
        return arg0.setColorAdaptation(arg1);
    }
    
    void TonemapReinhard_setIntensity_wrapper(cv::TonemapReinhard& arg0 , float arg1) {
        return arg0.setIntensity(arg1);
    }
    
    void TonemapReinhard_setLightAdaptation_wrapper(cv::TonemapReinhard& arg0 , float arg1) {
        return arg0.setLightAdaptation(arg1);
    }
    
    Ptr<cv::TrackerMIL> TrackerMIL_create_wrapper(const TrackerMIL_Params& arg1) {
        return cv::TrackerMIL::create(arg1);
    }
    
    Ptr<cv::TrackerMIL> TrackerMIL_create_wrapper_1() {
        return cv::TrackerMIL::create();
    }
    
    void aruco_ArucoDetector_detectMarkers_wrapper(cv::aruco::ArucoDetector& arg0 , const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3, std::vector<cv::Mat>& arg4) {
        return arg0.detectMarkers(arg1, arg2, arg3, arg4);
    }
    
    void aruco_ArucoDetector_detectMarkers_wrapper_1(cv::aruco::ArucoDetector& arg0 , const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3) {
        return arg0.detectMarkers(arg1, arg2, arg3);
    }
    
    void aruco_ArucoDetector_refineDetectedMarkers_wrapper(cv::aruco::ArucoDetector& arg0 , const cv::Mat& arg1, const Board& arg2, std::vector<cv::Mat>& arg3, cv::Mat& arg4, std::vector<cv::Mat>& arg5, const cv::Mat& arg6, const cv::Mat& arg7, cv::Mat& arg8) {
        return arg0.refineDetectedMarkers(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
    }
    
    void aruco_ArucoDetector_refineDetectedMarkers_wrapper_1(cv::aruco::ArucoDetector& arg0 , const cv::Mat& arg1, const Board& arg2, std::vector<cv::Mat>& arg3, cv::Mat& arg4, std::vector<cv::Mat>& arg5, const cv::Mat& arg6, const cv::Mat& arg7) {
        return arg0.refineDetectedMarkers(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }
    
    void aruco_ArucoDetector_refineDetectedMarkers_wrapper_2(cv::aruco::ArucoDetector& arg0 , const cv::Mat& arg1, const Board& arg2, std::vector<cv::Mat>& arg3, cv::Mat& arg4, std::vector<cv::Mat>& arg5, const cv::Mat& arg6) {
        return arg0.refineDetectedMarkers(arg1, arg2, arg3, arg4, arg5, arg6);
    }
    
    void aruco_ArucoDetector_refineDetectedMarkers_wrapper_3(cv::aruco::ArucoDetector& arg0 , const cv::Mat& arg1, const Board& arg2, std::vector<cv::Mat>& arg3, cv::Mat& arg4, std::vector<cv::Mat>& arg5) {
        return arg0.refineDetectedMarkers(arg1, arg2, arg3, arg4, arg5);
    }
    
    void aruco_ArucoDetector_setDetectorParameters_wrapper(cv::aruco::ArucoDetector& arg0 , const DetectorParameters& arg1) {
        return arg0.setDetectorParameters(arg1);
    }
    
    void aruco_ArucoDetector_setDictionary_wrapper(cv::aruco::ArucoDetector& arg0 , const Dictionary& arg1) {
        return arg0.setDictionary(arg1);
    }
    
    void aruco_ArucoDetector_setRefineParameters_wrapper(cv::aruco::ArucoDetector& arg0 , const RefineParameters& arg1) {
        return arg0.setRefineParameters(arg1);
    }
    
    void aruco_Board_generateImage_wrapper(cv::aruco::Board& arg0 , Size arg1, cv::Mat& arg2, int arg3, int arg4) {
        return arg0.generateImage(arg1, arg2, arg3, arg4);
    }
    
    void aruco_Board_generateImage_wrapper_1(cv::aruco::Board& arg0 , Size arg1, cv::Mat& arg2, int arg3) {
        return arg0.generateImage(arg1, arg2, arg3);
    }
    
    void aruco_Board_generateImage_wrapper_2(cv::aruco::Board& arg0 , Size arg1, cv::Mat& arg2) {
        return arg0.generateImage(arg1, arg2);
    }
    
    void aruco_Board_matchImagePoints_wrapper(cv::aruco::Board& arg0 , const std::vector<cv::Mat>& arg1, const cv::Mat& arg2, cv::Mat& arg3, cv::Mat& arg4) {
        return arg0.matchImagePoints(arg1, arg2, arg3, arg4);
    }
    
    bool aruco_CharucoBoard_checkCharucoCornersCollinear_wrapper(cv::aruco::CharucoBoard& arg0 , const cv::Mat& arg1) {
        return arg0.checkCharucoCornersCollinear(arg1);
    }
    
    void aruco_CharucoBoard_setLegacyPattern_wrapper(cv::aruco::CharucoBoard& arg0 , bool arg1) {
        return arg0.setLegacyPattern(arg1);
    }
    
    void aruco_CharucoDetector_detectBoard_wrapper(cv::aruco::CharucoDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, std::vector<cv::Mat>& arg4, cv::Mat& arg5) {
        return arg0.detectBoard(arg1, arg2, arg3, arg4, arg5);
    }
    
    void aruco_CharucoDetector_detectBoard_wrapper_1(cv::aruco::CharucoDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3, std::vector<cv::Mat>& arg4) {
        return arg0.detectBoard(arg1, arg2, arg3, arg4);
    }
    
    void aruco_CharucoDetector_detectBoard_wrapper_2(cv::aruco::CharucoDetector& arg0 , const cv::Mat& arg1, cv::Mat& arg2, cv::Mat& arg3) {
        return arg0.detectBoard(arg1, arg2, arg3);
    }
    
    void aruco_CharucoDetector_detectDiamonds_wrapper(cv::aruco::CharucoDetector& arg0 , const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3, std::vector<cv::Mat>& arg4, cv::Mat& arg5) {
        return arg0.detectDiamonds(arg1, arg2, arg3, arg4, arg5);
    }
    
    void aruco_CharucoDetector_detectDiamonds_wrapper_1(cv::aruco::CharucoDetector& arg0 , const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3, std::vector<cv::Mat>& arg4) {
        return arg0.detectDiamonds(arg1, arg2, arg3, arg4);
    }
    
    void aruco_CharucoDetector_detectDiamonds_wrapper_2(cv::aruco::CharucoDetector& arg0 , const cv::Mat& arg1, std::vector<cv::Mat>& arg2, cv::Mat& arg3) {
        return arg0.detectDiamonds(arg1, arg2, arg3);
    }
    
    void aruco_CharucoDetector_setBoard_wrapper(cv::aruco::CharucoDetector& arg0 , const CharucoBoard& arg1) {
        return arg0.setBoard(arg1);
    }
    
    void aruco_CharucoDetector_setCharucoParameters_wrapper(cv::aruco::CharucoDetector& arg0 , CharucoParameters& arg1) {
        return arg0.setCharucoParameters(arg1);
    }
    
    void aruco_CharucoDetector_setDetectorParameters_wrapper(cv::aruco::CharucoDetector& arg0 , const DetectorParameters& arg1) {
        return arg0.setDetectorParameters(arg1);
    }
    
    void aruco_CharucoDetector_setRefineParameters_wrapper(cv::aruco::CharucoDetector& arg0 , const RefineParameters& arg1) {
        return arg0.setRefineParameters(arg1);
    }
    
    void aruco_Dictionary_generateImageMarker_wrapper(cv::aruco::Dictionary& arg0 , int arg1, int arg2, cv::Mat& arg3, int arg4) {
        return arg0.generateImageMarker(arg1, arg2, arg3, arg4);
    }
    
    void aruco_Dictionary_generateImageMarker_wrapper_1(cv::aruco::Dictionary& arg0 , int arg1, int arg2, cv::Mat& arg3) {
        return arg0.generateImageMarker(arg1, arg2, arg3);
    }
    
    Mat aruco_Dictionary_getBitsFromByteList_wrapper(cv::aruco::Dictionary& arg0 , const cv::Mat&& arg1, int arg2, int arg3) {
        return arg0.getBitsFromByteList(arg1, arg2, arg3);
    }
    
    Mat aruco_Dictionary_getBitsFromByteList_wrapper_1(cv::aruco::Dictionary& arg0 , const cv::Mat&& arg1, int arg2) {
        return arg0.getBitsFromByteList(arg1, arg2);
    }
    
    Mat aruco_Dictionary_getByteListFromBits_wrapper(cv::aruco::Dictionary& arg0 , const cv::Mat&& arg1) {
        return arg0.getByteListFromBits(arg1);
    }
    
    int aruco_Dictionary_getDistanceToId_wrapper(cv::aruco::Dictionary& arg0 , const cv::Mat& arg1, int arg2, bool arg3) {
        return arg0.getDistanceToId(arg1, arg2, arg3);
    }
    
    int aruco_Dictionary_getDistanceToId_wrapper_1(cv::aruco::Dictionary& arg0 , const cv::Mat& arg1, int arg2) {
        return arg0.getDistanceToId(arg1, arg2);
    }
    
    bool barcode_BarcodeDetector_decodeWithType_wrapper(cv::barcode::BarcodeDetector& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, std::vector<string>& arg3, std::vector<string>& arg4) {
        return arg0.decodeWithType(arg1, arg2, arg3, arg4);
    }
    
    bool barcode_BarcodeDetector_detectAndDecodeWithType_wrapper(cv::barcode::BarcodeDetector& arg0 , const cv::Mat& arg1, std::vector<string>& arg2, std::vector<string>& arg3, cv::Mat& arg4) {
        return arg0.detectAndDecodeWithType(arg1, arg2, arg3, arg4);
    }
    
    bool barcode_BarcodeDetector_detectAndDecodeWithType_wrapper_1(cv::barcode::BarcodeDetector& arg0 , const cv::Mat& arg1, std::vector<string>& arg2, std::vector<string>& arg3) {
        return arg0.detectAndDecodeWithType(arg1, arg2, arg3);
    }
    
    Mat dnn_Net_forward_wrapper(cv::dnn::Net& arg0 , const std::string& arg1) {
        return arg0.forward(arg1);
    }
    
    Mat dnn_Net_forward_wrapper_1(cv::dnn::Net& arg0 ) {
        return arg0.forward();
    }
    
    void dnn_Net_forward_wrapper1(cv::dnn::Net& arg0 , std::vector<cv::Mat>& arg1, const std::string& arg2) {
        return arg0.forward(arg1, arg2);
    }
    
    void dnn_Net_forward_wrapper1_1(cv::dnn::Net& arg0 , std::vector<cv::Mat>& arg1) {
        return arg0.forward(arg1);
    }
    
    void dnn_Net_forward_wrapper2(cv::dnn::Net& arg0 , std::vector<cv::Mat>& arg1, const emscripten::val& arg2) {
        return arg0.forward(arg1, emscripten::vecFromJSArray<String>(arg2));
    }
    
    std::vector<String> dnn_Net_getUnconnectedOutLayersNames_wrapper(cv::dnn::Net& arg0 ) {
        return arg0.getUnconnectedOutLayersNames();
    }
    
    void dnn_Net_setInput_wrapper(cv::dnn::Net& arg0 , const cv::Mat& arg1, const std::string& arg2, double arg3, const Scalar& arg4) {
        return arg0.setInput(arg1, arg2, arg3, arg4);
    }
    
    void dnn_Net_setInput_wrapper_1(cv::dnn::Net& arg0 , const cv::Mat& arg1, const std::string& arg2, double arg3) {
        return arg0.setInput(arg1, arg2, arg3);
    }
    
    void dnn_Net_setInput_wrapper_2(cv::dnn::Net& arg0 , const cv::Mat& arg1, const std::string& arg2) {
        return arg0.setInput(arg1, arg2);
    }
    
    void dnn_Net_setInput_wrapper_3(cv::dnn::Net& arg0 , const cv::Mat& arg1) {
        return arg0.setInput(arg1);
    }
    
    void dnn_Net_setPreferableBackend_wrapper(cv::dnn::Net& arg0 , int arg1) {
        return arg0.setPreferableBackend(arg1);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_applyImage_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , const cv::Mat& arg1) {
        return arg0.applyImage(arg1);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_applyImageFeatures_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3, const cv::Mat& arg4) {
        return arg0.applyImageFeatures(arg1, arg2, arg3, arg4);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_applyImageFeatures_wrapper_1(cv::segmentation::IntelligentScissorsMB& arg0 , const cv::Mat& arg1, const cv::Mat& arg2, const cv::Mat& arg3) {
        return arg0.applyImageFeatures(arg1, arg2, arg3);
    }
    
    void segmentation_IntelligentScissorsMB_buildMap_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , const Point& arg1) {
        return arg0.buildMap(arg1);
    }
    
    void segmentation_IntelligentScissorsMB_getContour_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , const Point& arg1, cv::Mat& arg2, bool arg3) {
        return arg0.getContour(arg1, arg2, arg3);
    }
    
    void segmentation_IntelligentScissorsMB_getContour_wrapper_1(cv::segmentation::IntelligentScissorsMB& arg0 , const Point& arg1, cv::Mat& arg2) {
        return arg0.getContour(arg1, arg2);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setEdgeFeatureCannyParameters_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , double arg1, double arg2, int arg3, bool arg4) {
        return arg0.setEdgeFeatureCannyParameters(arg1, arg2, arg3, arg4);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setEdgeFeatureCannyParameters_wrapper_1(cv::segmentation::IntelligentScissorsMB& arg0 , double arg1, double arg2, int arg3) {
        return arg0.setEdgeFeatureCannyParameters(arg1, arg2, arg3);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setEdgeFeatureCannyParameters_wrapper_2(cv::segmentation::IntelligentScissorsMB& arg0 , double arg1, double arg2) {
        return arg0.setEdgeFeatureCannyParameters(arg1, arg2);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setEdgeFeatureZeroCrossingParameters_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , float arg1) {
        return arg0.setEdgeFeatureZeroCrossingParameters(arg1);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setEdgeFeatureZeroCrossingParameters_wrapper_1(cv::segmentation::IntelligentScissorsMB& arg0 ) {
        return arg0.setEdgeFeatureZeroCrossingParameters();
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setGradientMagnitudeMaxLimit_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , float arg1) {
        return arg0.setGradientMagnitudeMaxLimit(arg1);
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setGradientMagnitudeMaxLimit_wrapper_1(cv::segmentation::IntelligentScissorsMB& arg0 ) {
        return arg0.setGradientMagnitudeMaxLimit();
    }
    
    IntelligentScissorsMB segmentation_IntelligentScissorsMB_setWeights_wrapper(cv::segmentation::IntelligentScissorsMB& arg0 , float arg1, float arg2, float arg3) {
        return arg0.setWeights(arg1, arg2, arg3);
    }
    
}

EMSCRIPTEN_BINDINGS(testBinding) {
    function("Canny", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, bool)>(&Wrappers::Canny_wrapper));

    function("Canny", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int)>(&Wrappers::Canny_wrapper_1));

    function("Canny", select_overload<void(const cv::Mat&, cv::Mat&, double, double)>(&Wrappers::Canny_wrapper_2));

    function("Canny1", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double, double, bool)>(&Wrappers::Canny_wrapper1));

    function("Canny1", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double, double)>(&Wrappers::Canny_wrapper1_1));

    function("GaussianBlur", select_overload<void(const cv::Mat&, cv::Mat&, Size, double, double, int, cv::AlgorithmHint)>(&Wrappers::GaussianBlur_wrapper));

    function("GaussianBlur", select_overload<void(const cv::Mat&, cv::Mat&, Size, double, double, int)>(&Wrappers::GaussianBlur_wrapper_1));

    function("GaussianBlur", select_overload<void(const cv::Mat&, cv::Mat&, Size, double, double)>(&Wrappers::GaussianBlur_wrapper_2));

    function("GaussianBlur", select_overload<void(const cv::Mat&, cv::Mat&, Size, double)>(&Wrappers::GaussianBlur_wrapper_3));

    function("HoughCircles", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, double, double, int, int)>(&Wrappers::HoughCircles_wrapper));

    function("HoughCircles", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, double, double, int)>(&Wrappers::HoughCircles_wrapper_1));

    function("HoughCircles", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, double, double)>(&Wrappers::HoughCircles_wrapper_2));

    function("HoughCircles", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, double)>(&Wrappers::HoughCircles_wrapper_3));

    function("HoughCircles", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double)>(&Wrappers::HoughCircles_wrapper_4));

    function("HoughLines", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, double, double, double, double, bool)>(&Wrappers::HoughLines_wrapper));

    function("HoughLines", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, double, double, double, double)>(&Wrappers::HoughLines_wrapper_1));

    function("HoughLines", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, double, double, double)>(&Wrappers::HoughLines_wrapper_2));

    function("HoughLines", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, double, double)>(&Wrappers::HoughLines_wrapper_3));

    function("HoughLines", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, double)>(&Wrappers::HoughLines_wrapper_4));

    function("HoughLines", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int)>(&Wrappers::HoughLines_wrapper_5));

    function("HoughLinesP", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, double, double)>(&Wrappers::HoughLinesP_wrapper));

    function("HoughLinesP", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, double)>(&Wrappers::HoughLinesP_wrapper_1));

    function("HoughLinesP", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int)>(&Wrappers::HoughLinesP_wrapper_2));

    function("HuMoments", select_overload<void(const Moments&, cv::Mat&)>(&Wrappers::HuMoments_wrapper));

    function("LUT", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::LUT_wrapper));

    function("Laplacian", select_overload<void(const cv::Mat&, cv::Mat&, int, int, double, double, int)>(&Wrappers::Laplacian_wrapper));

    function("Laplacian", select_overload<void(const cv::Mat&, cv::Mat&, int, int, double, double)>(&Wrappers::Laplacian_wrapper_1));

    function("Laplacian", select_overload<void(const cv::Mat&, cv::Mat&, int, int, double)>(&Wrappers::Laplacian_wrapper_2));

    function("Laplacian", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::Laplacian_wrapper_3));

    function("Laplacian", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::Laplacian_wrapper_4));

    function("Rodrigues", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::Rodrigues_wrapper));

    function("Rodrigues", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::Rodrigues_wrapper_1));

    function("Scharr", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, double, double, int)>(&Wrappers::Scharr_wrapper));

    function("Scharr", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, double, double)>(&Wrappers::Scharr_wrapper_1));

    function("Scharr", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, double)>(&Wrappers::Scharr_wrapper_2));

    function("Scharr", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int)>(&Wrappers::Scharr_wrapper_3));

    function("Sobel", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, int, double, double, int)>(&Wrappers::Sobel_wrapper));

    function("Sobel", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, int, double, double)>(&Wrappers::Sobel_wrapper_1));

    function("Sobel", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, int, double)>(&Wrappers::Sobel_wrapper_2));

    function("Sobel", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, int)>(&Wrappers::Sobel_wrapper_3));

    function("Sobel", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int)>(&Wrappers::Sobel_wrapper_4));

    function("absdiff", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::absdiff_wrapper));

    function("adaptiveThreshold", select_overload<void(const cv::Mat&, cv::Mat&, double, int, int, int, double)>(&Wrappers::adaptiveThreshold_wrapper));

    function("add", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&, int)>(&Wrappers::add_wrapper));

    function("add", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::add_wrapper_1));

    function("add", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::add_wrapper_2));

    function("addWeighted", select_overload<void(const cv::Mat&, double, const cv::Mat&, double, double, cv::Mat&, int)>(&Wrappers::addWeighted_wrapper));

    function("addWeighted", select_overload<void(const cv::Mat&, double, const cv::Mat&, double, double, cv::Mat&)>(&Wrappers::addWeighted_wrapper_1));

    function("applyColorMap", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::applyColorMap_wrapper));

    function("applyColorMap1", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::applyColorMap_wrapper1));

    function("approxPolyDP", select_overload<void(const cv::Mat&, cv::Mat&, double, bool)>(&Wrappers::approxPolyDP_wrapper));

    function("approxPolyN", select_overload<void(const cv::Mat&, cv::Mat&, int, float, bool)>(&Wrappers::approxPolyN_wrapper));

    function("approxPolyN", select_overload<void(const cv::Mat&, cv::Mat&, int, float)>(&Wrappers::approxPolyN_wrapper_1));

    function("approxPolyN", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::approxPolyN_wrapper_2));

    function("arcLength", select_overload<double(const cv::Mat&, bool)>(&Wrappers::arcLength_wrapper));

    function("arrowedLine", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int, int, int, double)>(&Wrappers::arrowedLine_wrapper));

    function("arrowedLine", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int, int, int)>(&Wrappers::arrowedLine_wrapper_1));

    function("arrowedLine", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int, int)>(&Wrappers::arrowedLine_wrapper_2));

    function("arrowedLine", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int)>(&Wrappers::arrowedLine_wrapper_3));

    function("arrowedLine", select_overload<void(cv::Mat&, Point, Point, const Scalar&)>(&Wrappers::arrowedLine_wrapper_4));

    function("bilateralFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, int)>(&Wrappers::bilateralFilter_wrapper));

    function("bilateralFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double)>(&Wrappers::bilateralFilter_wrapper_1));

    function("bitwise_and", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::bitwise_and_wrapper));

    function("bitwise_and", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::bitwise_and_wrapper_1));

    function("bitwise_not", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::bitwise_not_wrapper));

    function("bitwise_not", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::bitwise_not_wrapper_1));

    function("bitwise_or", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::bitwise_or_wrapper));

    function("bitwise_or", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::bitwise_or_wrapper_1));

    function("bitwise_xor", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::bitwise_xor_wrapper));

    function("bitwise_xor", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::bitwise_xor_wrapper_1));

    function("blendLinear", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::blendLinear_wrapper));

    function("blur", select_overload<void(const cv::Mat&, cv::Mat&, Size, Point, int)>(&Wrappers::blur_wrapper));

    function("blur", select_overload<void(const cv::Mat&, cv::Mat&, Size, Point)>(&Wrappers::blur_wrapper_1));

    function("blur", select_overload<void(const cv::Mat&, cv::Mat&, Size)>(&Wrappers::blur_wrapper_2));

    function("boundingRect", select_overload<Rect(const cv::Mat&)>(&Wrappers::boundingRect_wrapper));

    function("boxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size, Point, bool, int)>(&Wrappers::boxFilter_wrapper));

    function("boxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size, Point, bool)>(&Wrappers::boxFilter_wrapper_1));

    function("boxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size, Point)>(&Wrappers::boxFilter_wrapper_2));

    function("boxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size)>(&Wrappers::boxFilter_wrapper_3));

    function("calcBackProject", select_overload<void(const std::vector<cv::Mat>&, const emscripten::val&, const cv::Mat&, cv::Mat&, const emscripten::val&, double)>(&Wrappers::calcBackProject_wrapper));

    function("calcHist", select_overload<void(const std::vector<cv::Mat>&, const emscripten::val&, const cv::Mat&, cv::Mat&, const emscripten::val&, const emscripten::val&, bool)>(&Wrappers::calcHist_wrapper));

    function("calcHist", select_overload<void(const std::vector<cv::Mat>&, const emscripten::val&, const cv::Mat&, cv::Mat&, const emscripten::val&, const emscripten::val&)>(&Wrappers::calcHist_wrapper_1));

    function("calcOpticalFlowFarneback", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double, int, int, int, int, double, int)>(&Wrappers::calcOpticalFlowFarneback_wrapper));

    function("calcOpticalFlowPyrLK", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, Size, int, TermCriteria, int, double)>(&Wrappers::calcOpticalFlowPyrLK_wrapper));

    function("calcOpticalFlowPyrLK", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, Size, int, TermCriteria, int)>(&Wrappers::calcOpticalFlowPyrLK_wrapper_1));

    function("calcOpticalFlowPyrLK", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, Size, int, TermCriteria)>(&Wrappers::calcOpticalFlowPyrLK_wrapper_2));

    function("calcOpticalFlowPyrLK", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, Size, int)>(&Wrappers::calcOpticalFlowPyrLK_wrapper_3));

    function("calcOpticalFlowPyrLK", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, Size)>(&Wrappers::calcOpticalFlowPyrLK_wrapper_4));

    function("calcOpticalFlowPyrLK", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::calcOpticalFlowPyrLK_wrapper_5));

    function("calibrateCameraExtended", select_overload<double(const std::vector<cv::Mat>&, const std::vector<cv::Mat>&, Size, cv::Mat&, cv::Mat&, std::vector<cv::Mat>&, std::vector<cv::Mat>&, cv::Mat&, cv::Mat&, cv::Mat&, int, TermCriteria)>(&Wrappers::calibrateCameraExtended_wrapper));

    function("calibrateCameraExtended", select_overload<double(const std::vector<cv::Mat>&, const std::vector<cv::Mat>&, Size, cv::Mat&, cv::Mat&, std::vector<cv::Mat>&, std::vector<cv::Mat>&, cv::Mat&, cv::Mat&, cv::Mat&, int)>(&Wrappers::calibrateCameraExtended_wrapper_1));

    function("calibrateCameraExtended", select_overload<double(const std::vector<cv::Mat>&, const std::vector<cv::Mat>&, Size, cv::Mat&, cv::Mat&, std::vector<cv::Mat>&, std::vector<cv::Mat>&, cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::calibrateCameraExtended_wrapper_2));

    function("cartToPolar", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool)>(&Wrappers::cartToPolar_wrapper));

    function("cartToPolar", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::cartToPolar_wrapper_1));

    function("circle", select_overload<void(cv::Mat&, Point, int, const Scalar&, int, int, int)>(&Wrappers::circle_wrapper));

    function("circle", select_overload<void(cv::Mat&, Point, int, const Scalar&, int, int)>(&Wrappers::circle_wrapper_1));

    function("circle", select_overload<void(cv::Mat&, Point, int, const Scalar&, int)>(&Wrappers::circle_wrapper_2));

    function("circle", select_overload<void(cv::Mat&, Point, int, const Scalar&)>(&Wrappers::circle_wrapper_3));

    function("clipLine", select_overload<bool(Rect, Point&, Point&)>(&Wrappers::clipLine_wrapper));

    function("compare", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, int)>(&Wrappers::compare_wrapper));

    function("compareHist", select_overload<double(const cv::Mat&, const cv::Mat&, int)>(&Wrappers::compareHist_wrapper));

    function("connectedComponents", select_overload<int(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::connectedComponents_wrapper));

    function("connectedComponents", select_overload<int(const cv::Mat&, cv::Mat&, int)>(&Wrappers::connectedComponents_wrapper_1));

    function("connectedComponents", select_overload<int(const cv::Mat&, cv::Mat&)>(&Wrappers::connectedComponents_wrapper_2));

    function("connectedComponentsWithStats", select_overload<int(const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, int, int)>(&Wrappers::connectedComponentsWithStats_wrapper));

    function("connectedComponentsWithStats", select_overload<int(const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, int)>(&Wrappers::connectedComponentsWithStats_wrapper_1));

    function("connectedComponentsWithStats", select_overload<int(const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::connectedComponentsWithStats_wrapper_2));

    function("contourArea", select_overload<double(const cv::Mat&, bool)>(&Wrappers::contourArea_wrapper));

    function("contourArea", select_overload<double(const cv::Mat&)>(&Wrappers::contourArea_wrapper_1));

    function("convertMaps", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, int, bool)>(&Wrappers::convertMaps_wrapper));

    function("convertMaps", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, int)>(&Wrappers::convertMaps_wrapper_1));

    function("convertScaleAbs", select_overload<void(const cv::Mat&, cv::Mat&, double, double)>(&Wrappers::convertScaleAbs_wrapper));

    function("convertScaleAbs", select_overload<void(const cv::Mat&, cv::Mat&, double)>(&Wrappers::convertScaleAbs_wrapper_1));

    function("convertScaleAbs", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::convertScaleAbs_wrapper_2));

    function("convexHull", select_overload<void(const cv::Mat&, cv::Mat&, bool, bool)>(&Wrappers::convexHull_wrapper));

    function("convexHull", select_overload<void(const cv::Mat&, cv::Mat&, bool)>(&Wrappers::convexHull_wrapper_1));

    function("convexHull", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::convexHull_wrapper_2));

    function("convexityDefects", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::convexityDefects_wrapper));

    function("copyMakeBorder", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, int, int, const Scalar&)>(&Wrappers::copyMakeBorder_wrapper));

    function("copyMakeBorder", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int, int, int)>(&Wrappers::copyMakeBorder_wrapper_1));

    function("cornerHarris", select_overload<void(const cv::Mat&, cv::Mat&, int, int, double, int)>(&Wrappers::cornerHarris_wrapper));

    function("cornerHarris", select_overload<void(const cv::Mat&, cv::Mat&, int, int, double)>(&Wrappers::cornerHarris_wrapper_1));

    function("cornerMinEigenVal", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int)>(&Wrappers::cornerMinEigenVal_wrapper));

    function("cornerMinEigenVal", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::cornerMinEigenVal_wrapper_1));

    function("cornerMinEigenVal", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::cornerMinEigenVal_wrapper_2));

    function("countNonZero", select_overload<int(const cv::Mat&)>(&Wrappers::countNonZero_wrapper));

    function("createHanningWindow", select_overload<void(cv::Mat&, Size, int)>(&Wrappers::createHanningWindow_wrapper));

    function("cvtColor", select_overload<void(const cv::Mat&, cv::Mat&, int, int, cv::AlgorithmHint)>(&Wrappers::cvtColor_wrapper));

    function("cvtColor", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::cvtColor_wrapper_1));

    function("cvtColor", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::cvtColor_wrapper_2));

    function("demosaicing", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::demosaicing_wrapper));

    function("demosaicing", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::demosaicing_wrapper_1));

    function("determinant", select_overload<double(const cv::Mat&)>(&Wrappers::determinant_wrapper));

    function("dft", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::dft_wrapper));

    function("dft", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::dft_wrapper_1));

    function("dft", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::dft_wrapper_2));

    function("dilate", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point, int, int, const Scalar&)>(&Wrappers::dilate_wrapper));

    function("dilate", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point, int, int)>(&Wrappers::dilate_wrapper_1));

    function("dilate", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point, int)>(&Wrappers::dilate_wrapper_2));

    function("dilate", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point)>(&Wrappers::dilate_wrapper_3));

    function("dilate", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::dilate_wrapper_4));

    function("distanceTransform", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int)>(&Wrappers::distanceTransform_wrapper));

    function("distanceTransform", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::distanceTransform_wrapper_1));

    function("distanceTransformWithLabels", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&, int, int, int)>(&Wrappers::distanceTransformWithLabels_wrapper));

    function("distanceTransformWithLabels", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&, int, int)>(&Wrappers::distanceTransformWithLabels_wrapper_1));

    function("divSpectrums", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, int, bool)>(&Wrappers::divSpectrums_wrapper));

    function("divSpectrums", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, int)>(&Wrappers::divSpectrums_wrapper_1));

    function("divide", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double, int)>(&Wrappers::divide_wrapper));

    function("divide", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double)>(&Wrappers::divide_wrapper_1));

    function("divide", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::divide_wrapper_2));

    function("divide1", select_overload<void(double, const cv::Mat&, cv::Mat&, int)>(&Wrappers::divide_wrapper1));

    function("divide1", select_overload<void(double, const cv::Mat&, cv::Mat&)>(&Wrappers::divide_wrapper1_1));

    function("drawContours", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, int, const Scalar&, int, int, const cv::Mat&, int, Point)>(&Wrappers::drawContours_wrapper));

    function("drawContours", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, int, const Scalar&, int, int, const cv::Mat&, int)>(&Wrappers::drawContours_wrapper_1));

    function("drawContours", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, int, const Scalar&, int, int, const cv::Mat&)>(&Wrappers::drawContours_wrapper_2));

    function("drawContours", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, int, const Scalar&, int, int)>(&Wrappers::drawContours_wrapper_3));

    function("drawContours", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, int, const Scalar&, int)>(&Wrappers::drawContours_wrapper_4));

    function("drawContours", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, int, const Scalar&)>(&Wrappers::drawContours_wrapper_5));

    function("drawFrameAxes", select_overload<void(cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, float, int)>(&Wrappers::drawFrameAxes_wrapper));

    function("drawFrameAxes", select_overload<void(cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, float)>(&Wrappers::drawFrameAxes_wrapper_1));

    function("drawKeypoints", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, cv::Mat&, const Scalar&, cv::DrawMatchesFlags)>(&Wrappers::drawKeypoints_wrapper));

    function("drawKeypoints", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, cv::Mat&, const Scalar&)>(&Wrappers::drawKeypoints_wrapper_1));

    function("drawKeypoints", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, cv::Mat&)>(&Wrappers::drawKeypoints_wrapper_2));

    function("drawMarker", select_overload<void(cv::Mat&, Point, const Scalar&, int, int, int, int)>(&Wrappers::drawMarker_wrapper));

    function("drawMarker", select_overload<void(cv::Mat&, Point, const Scalar&, int, int, int)>(&Wrappers::drawMarker_wrapper_1));

    function("drawMarker", select_overload<void(cv::Mat&, Point, const Scalar&, int, int)>(&Wrappers::drawMarker_wrapper_2));

    function("drawMarker", select_overload<void(cv::Mat&, Point, const Scalar&, int)>(&Wrappers::drawMarker_wrapper_3));

    function("drawMarker", select_overload<void(cv::Mat&, Point, const Scalar&)>(&Wrappers::drawMarker_wrapper_4));

    function("drawMatches", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const Scalar&, const Scalar&, const emscripten::val&, cv::DrawMatchesFlags)>(&Wrappers::drawMatches_wrapper));

    function("drawMatches", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const Scalar&, const Scalar&, const emscripten::val&)>(&Wrappers::drawMatches_wrapper_1));

    function("drawMatches", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const Scalar&, const Scalar&)>(&Wrappers::drawMatches_wrapper_2));

    function("drawMatches", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const Scalar&)>(&Wrappers::drawMatches_wrapper_3));

    function("drawMatches", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&)>(&Wrappers::drawMatches_wrapper_4));

    function("drawMatches1", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const int, const Scalar&, const Scalar&, const emscripten::val&, cv::DrawMatchesFlags)>(&Wrappers::drawMatches_wrapper1));

    function("drawMatches1", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const int, const Scalar&, const Scalar&, const emscripten::val&)>(&Wrappers::drawMatches_wrapper1_1));

    function("drawMatches1", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const int, const Scalar&, const Scalar&)>(&Wrappers::drawMatches_wrapper1_2));

    function("drawMatches1", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const int, const Scalar&)>(&Wrappers::drawMatches_wrapper1_3));

    function("drawMatches1", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<DMatch>&, cv::Mat&, const int)>(&Wrappers::drawMatches_wrapper1_4));

    function("drawMatchesKnn", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<std::vector<DMatch>>&, cv::Mat&, const Scalar&, const Scalar&, const std::vector<std::vector<char>>&, cv::DrawMatchesFlags)>(&Wrappers::drawMatchesKnn_wrapper));

    function("drawMatchesKnn", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<std::vector<DMatch>>&, cv::Mat&, const Scalar&, const Scalar&, const std::vector<std::vector<char>>&)>(&Wrappers::drawMatchesKnn_wrapper_1));

    function("drawMatchesKnn", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<std::vector<DMatch>>&, cv::Mat&, const Scalar&, const Scalar&)>(&Wrappers::drawMatchesKnn_wrapper_2));

    function("drawMatchesKnn", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<std::vector<DMatch>>&, cv::Mat&, const Scalar&)>(&Wrappers::drawMatchesKnn_wrapper_3));

    function("drawMatchesKnn", select_overload<void(const cv::Mat&, const std::vector<KeyPoint>&, const cv::Mat&, const std::vector<KeyPoint>&, const std::vector<std::vector<DMatch>>&, cv::Mat&)>(&Wrappers::drawMatchesKnn_wrapper_4));

    function("eigen", select_overload<bool(const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::eigen_wrapper));

    function("eigen", select_overload<bool(const cv::Mat&, cv::Mat&)>(&Wrappers::eigen_wrapper_1));

    function("ellipse", select_overload<void(cv::Mat&, Point, Size, double, double, double, const Scalar&, int, int, int)>(&Wrappers::ellipse_wrapper));

    function("ellipse", select_overload<void(cv::Mat&, Point, Size, double, double, double, const Scalar&, int, int)>(&Wrappers::ellipse_wrapper_1));

    function("ellipse", select_overload<void(cv::Mat&, Point, Size, double, double, double, const Scalar&, int)>(&Wrappers::ellipse_wrapper_2));

    function("ellipse", select_overload<void(cv::Mat&, Point, Size, double, double, double, const Scalar&)>(&Wrappers::ellipse_wrapper_3));

    function("ellipse1", select_overload<void(cv::Mat&, const RotatedRect&, const Scalar&, int, int)>(&Wrappers::ellipse_wrapper1));

    function("ellipse1", select_overload<void(cv::Mat&, const RotatedRect&, const Scalar&, int)>(&Wrappers::ellipse_wrapper1_1));

    function("ellipse1", select_overload<void(cv::Mat&, const RotatedRect&, const Scalar&)>(&Wrappers::ellipse_wrapper1_2));

    function("ellipse2Poly", select_overload<void(Point, Size, int, int, int, int, std::vector<Point>&)>(&Wrappers::ellipse2Poly_wrapper));

    function("equalizeHist", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::equalizeHist_wrapper));

    function("erode", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point, int, int, const Scalar&)>(&Wrappers::erode_wrapper));

    function("erode", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point, int, int)>(&Wrappers::erode_wrapper_1));

    function("erode", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point, int)>(&Wrappers::erode_wrapper_2));

    function("erode", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Point)>(&Wrappers::erode_wrapper_3));

    function("erode", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::erode_wrapper_4));

    function("estimateAffine2D", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&, int, double, size_t, double, size_t)>(&Wrappers::estimateAffine2D_wrapper));

    function("estimateAffine2D", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&, int, double, size_t, double)>(&Wrappers::estimateAffine2D_wrapper_1));

    function("estimateAffine2D", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&, int, double, size_t)>(&Wrappers::estimateAffine2D_wrapper_2));

    function("estimateAffine2D", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&, int, double)>(&Wrappers::estimateAffine2D_wrapper_3));

    function("estimateAffine2D", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&, int)>(&Wrappers::estimateAffine2D_wrapper_4));

    function("estimateAffine2D", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::estimateAffine2D_wrapper_5));

    function("estimateAffine2D", select_overload<Mat(const cv::Mat&, const cv::Mat&)>(&Wrappers::estimateAffine2D_wrapper_6));

    function("estimateAffine2D1", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&, const UsacParams&)>(&Wrappers::estimateAffine2D_wrapper1));

    function("exp", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::exp_wrapper));

    function("fillConvexPoly", select_overload<void(cv::Mat&, const cv::Mat&, const Scalar&, int, int)>(&Wrappers::fillConvexPoly_wrapper));

    function("fillConvexPoly", select_overload<void(cv::Mat&, const cv::Mat&, const Scalar&, int)>(&Wrappers::fillConvexPoly_wrapper_1));

    function("fillConvexPoly", select_overload<void(cv::Mat&, const cv::Mat&, const Scalar&)>(&Wrappers::fillConvexPoly_wrapper_2));

    function("fillPoly", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const Scalar&, int, int, Point)>(&Wrappers::fillPoly_wrapper));

    function("fillPoly", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const Scalar&, int, int)>(&Wrappers::fillPoly_wrapper_1));

    function("fillPoly", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const Scalar&, int)>(&Wrappers::fillPoly_wrapper_2));

    function("fillPoly", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const Scalar&)>(&Wrappers::fillPoly_wrapper_3));

    function("filter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, Point, double, int)>(&Wrappers::filter2D_wrapper));

    function("filter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, Point, double)>(&Wrappers::filter2D_wrapper_1));

    function("filter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, Point)>(&Wrappers::filter2D_wrapper_2));

    function("filter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&)>(&Wrappers::filter2D_wrapper_3));

    function("findContours", select_overload<void(const cv::Mat&, std::vector<cv::Mat>&, cv::Mat&, int, int, Point)>(&Wrappers::findContours_wrapper));

    function("findContours", select_overload<void(const cv::Mat&, std::vector<cv::Mat>&, cv::Mat&, int, int)>(&Wrappers::findContours_wrapper_1));

    function("findContoursLinkRuns", select_overload<void(const cv::Mat&, std::vector<cv::Mat>&, cv::Mat&)>(&Wrappers::findContoursLinkRuns_wrapper));

    function("findContoursLinkRuns1", select_overload<void(const cv::Mat&, std::vector<cv::Mat>&)>(&Wrappers::findContoursLinkRuns_wrapper1));

    function("findHomography", select_overload<Mat(const cv::Mat&, const cv::Mat&, int, double, cv::Mat&, const int, const double)>(&Wrappers::findHomography_wrapper));

    function("findHomography", select_overload<Mat(const cv::Mat&, const cv::Mat&, int, double, cv::Mat&, const int)>(&Wrappers::findHomography_wrapper_1));

    function("findHomography", select_overload<Mat(const cv::Mat&, const cv::Mat&, int, double, cv::Mat&)>(&Wrappers::findHomography_wrapper_2));

    function("findHomography", select_overload<Mat(const cv::Mat&, const cv::Mat&, int, double)>(&Wrappers::findHomography_wrapper_3));

    function("findHomography", select_overload<Mat(const cv::Mat&, const cv::Mat&, int)>(&Wrappers::findHomography_wrapper_4));

    function("findHomography", select_overload<Mat(const cv::Mat&, const cv::Mat&)>(&Wrappers::findHomography_wrapper_5));

    function("findHomography1", select_overload<Mat(const cv::Mat&, const cv::Mat&, cv::Mat&, const UsacParams&)>(&Wrappers::findHomography_wrapper1));

    function("findTransformECC", select_overload<double(const cv::Mat&, const cv::Mat&, cv::Mat&, int, TermCriteria, const cv::Mat&, int)>(&Wrappers::findTransformECC_wrapper));

    function("findTransformECC1", select_overload<double(const cv::Mat&, const cv::Mat&, cv::Mat&, int, TermCriteria, const cv::Mat&)>(&Wrappers::findTransformECC_wrapper1));

    function("findTransformECC1", select_overload<double(const cv::Mat&, const cv::Mat&, cv::Mat&, int, TermCriteria)>(&Wrappers::findTransformECC_wrapper1_1));

    function("findTransformECC1", select_overload<double(const cv::Mat&, const cv::Mat&, cv::Mat&, int)>(&Wrappers::findTransformECC_wrapper1_2));

    function("findTransformECC1", select_overload<double(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::findTransformECC_wrapper1_3));

    function("fitEllipse", select_overload<RotatedRect(const cv::Mat&)>(&Wrappers::fitEllipse_wrapper));

    function("fitEllipseAMS", select_overload<RotatedRect(const cv::Mat&)>(&Wrappers::fitEllipseAMS_wrapper));

    function("fitEllipseDirect", select_overload<RotatedRect(const cv::Mat&)>(&Wrappers::fitEllipseDirect_wrapper));

    function("fitLine", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, double)>(&Wrappers::fitLine_wrapper));

    function("flip", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::flip_wrapper));

    function("gemm", select_overload<void(const cv::Mat&, const cv::Mat&, double, const cv::Mat&, double, cv::Mat&, int)>(&Wrappers::gemm_wrapper));

    function("gemm", select_overload<void(const cv::Mat&, const cv::Mat&, double, const cv::Mat&, double, cv::Mat&)>(&Wrappers::gemm_wrapper_1));

    function("getAffineTransform", select_overload<Mat(const cv::Mat&, const cv::Mat&)>(&Wrappers::getAffineTransform_wrapper));

    function("getDefaultNewCameraMatrix", select_overload<Mat(const cv::Mat&, Size, bool)>(&Wrappers::getDefaultNewCameraMatrix_wrapper));

    function("getDefaultNewCameraMatrix", select_overload<Mat(const cv::Mat&, Size)>(&Wrappers::getDefaultNewCameraMatrix_wrapper_1));

    function("getDefaultNewCameraMatrix", select_overload<Mat(const cv::Mat&)>(&Wrappers::getDefaultNewCameraMatrix_wrapper_2));

    function("getFontScaleFromHeight", select_overload<double(const int, const int, const int)>(&Wrappers::getFontScaleFromHeight_wrapper));

    function("getFontScaleFromHeight", select_overload<double(const int, const int)>(&Wrappers::getFontScaleFromHeight_wrapper_1));

    function("getOptimalDFTSize", select_overload<int(int)>(&Wrappers::getOptimalDFTSize_wrapper));

    function("getPerspectiveTransform", select_overload<Mat(const cv::Mat&, const cv::Mat&, int)>(&Wrappers::getPerspectiveTransform_wrapper));

    function("getPerspectiveTransform", select_overload<Mat(const cv::Mat&, const cv::Mat&)>(&Wrappers::getPerspectiveTransform_wrapper_1));

    function("getRectSubPix", select_overload<void(const cv::Mat&, Size, Point2f, cv::Mat&, int)>(&Wrappers::getRectSubPix_wrapper));

    function("getRectSubPix", select_overload<void(const cv::Mat&, Size, Point2f, cv::Mat&)>(&Wrappers::getRectSubPix_wrapper_1));

    function("getRotationMatrix2D", select_overload<Mat(Point2f, double, double)>(&Wrappers::getRotationMatrix2D_wrapper));

    function("getStructuringElement", select_overload<Mat(int, Size, Point)>(&Wrappers::getStructuringElement_wrapper));

    function("getStructuringElement", select_overload<Mat(int, Size)>(&Wrappers::getStructuringElement_wrapper_1));

    function("goodFeaturesToTrack", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, const cv::Mat&, int, bool, double)>(&Wrappers::goodFeaturesToTrack_wrapper));

    function("goodFeaturesToTrack", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, const cv::Mat&, int, bool)>(&Wrappers::goodFeaturesToTrack_wrapper_1));

    function("goodFeaturesToTrack", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, const cv::Mat&, int)>(&Wrappers::goodFeaturesToTrack_wrapper_2));

    function("goodFeaturesToTrack", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, const cv::Mat&)>(&Wrappers::goodFeaturesToTrack_wrapper_3));

    function("goodFeaturesToTrack", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double)>(&Wrappers::goodFeaturesToTrack_wrapper_4));

    function("goodFeaturesToTrack1", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, const cv::Mat&, int, int, bool, double)>(&Wrappers::goodFeaturesToTrack_wrapper1));

    function("goodFeaturesToTrack1", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, const cv::Mat&, int, int, bool)>(&Wrappers::goodFeaturesToTrack_wrapper1_1));

    function("goodFeaturesToTrack1", select_overload<void(const cv::Mat&, cv::Mat&, int, double, double, const cv::Mat&, int, int)>(&Wrappers::goodFeaturesToTrack_wrapper1_2));

    function("grabCut", select_overload<void(const cv::Mat&, cv::Mat&, Rect, cv::Mat&, cv::Mat&, int, int)>(&Wrappers::grabCut_wrapper));

    function("grabCut", select_overload<void(const cv::Mat&, cv::Mat&, Rect, cv::Mat&, cv::Mat&, int)>(&Wrappers::grabCut_wrapper_1));

    function("groupRectangles", select_overload<void(std::vector<Rect>&, std::vector<int>&, int, double)>(&Wrappers::groupRectangles_wrapper));

    function("groupRectangles", select_overload<void(std::vector<Rect>&, std::vector<int>&, int)>(&Wrappers::groupRectangles_wrapper_1));

    function("hconcat", select_overload<void(const std::vector<cv::Mat>&, cv::Mat&)>(&Wrappers::hconcat_wrapper));

    function("inRange", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::inRange_wrapper));

    function("initUndistortRectifyMap", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, Size, int, cv::Mat&, cv::Mat&)>(&Wrappers::initUndistortRectifyMap_wrapper));

    function("inpaint", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double, int)>(&Wrappers::inpaint_wrapper));

    function("integral", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::integral_wrapper));

    function("integral", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::integral_wrapper_1));

    function("integral2", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&, int, int)>(&Wrappers::integral2_wrapper));

    function("integral2", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&, int)>(&Wrappers::integral2_wrapper_1));

    function("integral2", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::integral2_wrapper_2));

    function("intersectConvexConvex", select_overload<float(const cv::Mat&, const cv::Mat&, cv::Mat&, bool)>(&Wrappers::intersectConvexConvex_wrapper));

    function("intersectConvexConvex", select_overload<float(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::intersectConvexConvex_wrapper_1));

    function("invert", select_overload<double(const cv::Mat&, cv::Mat&, int)>(&Wrappers::invert_wrapper));

    function("invert", select_overload<double(const cv::Mat&, cv::Mat&)>(&Wrappers::invert_wrapper_1));

    function("invertAffineTransform", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::invertAffineTransform_wrapper));

    function("isContourConvex", select_overload<bool(const cv::Mat&)>(&Wrappers::isContourConvex_wrapper));

    function("kmeans", select_overload<double(const cv::Mat&, int, cv::Mat&, TermCriteria, int, int, cv::Mat&)>(&Wrappers::kmeans_wrapper));

    function("kmeans", select_overload<double(const cv::Mat&, int, cv::Mat&, TermCriteria, int, int)>(&Wrappers::kmeans_wrapper_1));

    function("line", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int, int, int)>(&Wrappers::line_wrapper));

    function("line", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int, int)>(&Wrappers::line_wrapper_1));

    function("line", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int)>(&Wrappers::line_wrapper_2));

    function("line", select_overload<void(cv::Mat&, Point, Point, const Scalar&)>(&Wrappers::line_wrapper_3));

    function("log", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::log_wrapper));

    function("magnitude", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::magnitude_wrapper));

    function("matchShapes", select_overload<double(const cv::Mat&, const cv::Mat&, int, double)>(&Wrappers::matchShapes_wrapper));

    function("matchTemplate", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, int, const cv::Mat&)>(&Wrappers::matchTemplate_wrapper));

    function("matchTemplate", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, int)>(&Wrappers::matchTemplate_wrapper_1));

    function("max", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::max_wrapper));

    function("mean", select_overload<Scalar(const cv::Mat&, const cv::Mat&)>(&Wrappers::mean_wrapper));

    function("mean", select_overload<Scalar(const cv::Mat&)>(&Wrappers::mean_wrapper_1));

    function("meanStdDev", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::meanStdDev_wrapper));

    function("meanStdDev", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::meanStdDev_wrapper_1));

    function("medianBlur", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::medianBlur_wrapper));

    function("merge", select_overload<void(const std::vector<cv::Mat>&, cv::Mat&)>(&Wrappers::merge_wrapper));

    function("min", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::min_wrapper));

    function("minAreaRect", select_overload<RotatedRect(const cv::Mat&)>(&Wrappers::minAreaRect_wrapper));

    function("minEnclosingTriangle", select_overload<double(const cv::Mat&, cv::Mat&)>(&Wrappers::minEnclosingTriangle_wrapper));

    function("mixChannels", select_overload<void(const std::vector<cv::Mat>&, std::vector<cv::Mat>&, const emscripten::val&)>(&Wrappers::mixChannels_wrapper));

    function("moments", select_overload<Moments(const cv::Mat&, bool)>(&Wrappers::moments_wrapper));

    function("moments", select_overload<Moments(const cv::Mat&)>(&Wrappers::moments_wrapper_1));

    function("morphologyEx", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, Point, int, int, const Scalar&)>(&Wrappers::morphologyEx_wrapper));

    function("morphologyEx", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, Point, int, int)>(&Wrappers::morphologyEx_wrapper_1));

    function("morphologyEx", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, Point, int)>(&Wrappers::morphologyEx_wrapper_2));

    function("morphologyEx", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, Point)>(&Wrappers::morphologyEx_wrapper_3));

    function("morphologyEx", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&)>(&Wrappers::morphologyEx_wrapper_4));

    function("multiply", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double, int)>(&Wrappers::multiply_wrapper));

    function("multiply", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, double)>(&Wrappers::multiply_wrapper_1));

    function("multiply", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::multiply_wrapper_2));

    function("norm", select_overload<double(const cv::Mat&, int, const cv::Mat&)>(&Wrappers::norm_wrapper));

    function("norm", select_overload<double(const cv::Mat&, int)>(&Wrappers::norm_wrapper_1));

    function("norm", select_overload<double(const cv::Mat&)>(&Wrappers::norm_wrapper_2));

    function("norm1", select_overload<double(const cv::Mat&, const cv::Mat&, int, const cv::Mat&)>(&Wrappers::norm_wrapper1));

    function("norm1", select_overload<double(const cv::Mat&, const cv::Mat&, int)>(&Wrappers::norm_wrapper1_1));

    function("norm1", select_overload<double(const cv::Mat&, const cv::Mat&)>(&Wrappers::norm_wrapper1_2));

    function("normalize", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, int, const cv::Mat&)>(&Wrappers::normalize_wrapper));

    function("normalize", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int, int)>(&Wrappers::normalize_wrapper_1));

    function("normalize", select_overload<void(const cv::Mat&, cv::Mat&, double, double, int)>(&Wrappers::normalize_wrapper_2));

    function("normalize", select_overload<void(const cv::Mat&, cv::Mat&, double, double)>(&Wrappers::normalize_wrapper_3));

    function("normalize", select_overload<void(const cv::Mat&, cv::Mat&, double)>(&Wrappers::normalize_wrapper_4));

    function("normalize", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::normalize_wrapper_5));

    function("perspectiveTransform", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::perspectiveTransform_wrapper));

    function("pointPolygonTest", select_overload<double(const cv::Mat&, Point2f, bool)>(&Wrappers::pointPolygonTest_wrapper));

    function("polarToCart", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool)>(&Wrappers::polarToCart_wrapper));

    function("polarToCart", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::polarToCart_wrapper_1));

    function("polylines", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, bool, const Scalar&, int, int, int)>(&Wrappers::polylines_wrapper));

    function("polylines", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, bool, const Scalar&, int, int)>(&Wrappers::polylines_wrapper_1));

    function("polylines", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, bool, const Scalar&, int)>(&Wrappers::polylines_wrapper_2));

    function("polylines", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, bool, const Scalar&)>(&Wrappers::polylines_wrapper_3));

    function("pow", select_overload<void(const cv::Mat&, double, cv::Mat&)>(&Wrappers::pow_wrapper));

    function("preCornerDetect", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::preCornerDetect_wrapper));

    function("preCornerDetect", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::preCornerDetect_wrapper_1));

    function("projectPoints", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, double)>(&Wrappers::projectPoints_wrapper));

    function("projectPoints", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::projectPoints_wrapper_1));

    function("projectPoints", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::projectPoints_wrapper_2));

    function("putText", select_overload<void(cv::Mat&, const std::string&, Point, int, double, Scalar, int, int, bool)>(&Wrappers::putText_wrapper));

    function("putText", select_overload<void(cv::Mat&, const std::string&, Point, int, double, Scalar, int, int)>(&Wrappers::putText_wrapper_1));

    function("putText", select_overload<void(cv::Mat&, const std::string&, Point, int, double, Scalar, int)>(&Wrappers::putText_wrapper_2));

    function("putText", select_overload<void(cv::Mat&, const std::string&, Point, int, double, Scalar)>(&Wrappers::putText_wrapper_3));

    function("pyrDown", select_overload<void(const cv::Mat&, cv::Mat&, const Size&, int)>(&Wrappers::pyrDown_wrapper));

    function("pyrDown", select_overload<void(const cv::Mat&, cv::Mat&, const Size&)>(&Wrappers::pyrDown_wrapper_1));

    function("pyrDown", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::pyrDown_wrapper_2));

    function("pyrUp", select_overload<void(const cv::Mat&, cv::Mat&, const Size&, int)>(&Wrappers::pyrUp_wrapper));

    function("pyrUp", select_overload<void(const cv::Mat&, cv::Mat&, const Size&)>(&Wrappers::pyrUp_wrapper_1));

    function("pyrUp", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::pyrUp_wrapper_2));

    function("randn", select_overload<void(cv::Mat&, const cv::Mat&, const cv::Mat&)>(&Wrappers::randn_wrapper));

    function("randu", select_overload<void(cv::Mat&, const cv::Mat&, const cv::Mat&)>(&Wrappers::randu_wrapper));

    function("rectangle", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int, int, int)>(&Wrappers::rectangle_wrapper));

    function("rectangle", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int, int)>(&Wrappers::rectangle_wrapper_1));

    function("rectangle", select_overload<void(cv::Mat&, Point, Point, const Scalar&, int)>(&Wrappers::rectangle_wrapper_2));

    function("rectangle", select_overload<void(cv::Mat&, Point, Point, const Scalar&)>(&Wrappers::rectangle_wrapper_3));

    function("rectangle1", select_overload<void(cv::Mat&, Rect, const Scalar&, int, int, int)>(&Wrappers::rectangle_wrapper1));

    function("rectangle1", select_overload<void(cv::Mat&, Rect, const Scalar&, int, int)>(&Wrappers::rectangle_wrapper1_1));

    function("rectangle1", select_overload<void(cv::Mat&, Rect, const Scalar&, int)>(&Wrappers::rectangle_wrapper1_2));

    function("rectangle1", select_overload<void(cv::Mat&, Rect, const Scalar&)>(&Wrappers::rectangle_wrapper1_3));

    function("reduce", select_overload<void(const cv::Mat&, cv::Mat&, int, int, int)>(&Wrappers::reduce_wrapper));

    function("reduce", select_overload<void(const cv::Mat&, cv::Mat&, int, int)>(&Wrappers::reduce_wrapper_1));

    function("remap", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&, int, int, const Scalar&)>(&Wrappers::remap_wrapper));

    function("remap", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&, int, int)>(&Wrappers::remap_wrapper_1));

    function("remap", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&, int)>(&Wrappers::remap_wrapper_2));

    function("repeat", select_overload<void(const cv::Mat&, int, int, cv::Mat&)>(&Wrappers::repeat_wrapper));

    function("resize", select_overload<void(const cv::Mat&, cv::Mat&, Size, double, double, int)>(&Wrappers::resize_wrapper));

    function("resize", select_overload<void(const cv::Mat&, cv::Mat&, Size, double, double)>(&Wrappers::resize_wrapper_1));

    function("resize", select_overload<void(const cv::Mat&, cv::Mat&, Size, double)>(&Wrappers::resize_wrapper_2));

    function("resize", select_overload<void(const cv::Mat&, cv::Mat&, Size)>(&Wrappers::resize_wrapper_3));

    function("rotate", select_overload<void(const cv::Mat&, cv::Mat&, int)>(&Wrappers::rotate_wrapper));

    function("rotatedRectangleIntersection", select_overload<int(const RotatedRect&, const RotatedRect&, cv::Mat&)>(&Wrappers::rotatedRectangleIntersection_wrapper));

    function("sepFilter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, const cv::Mat&, Point, double, int)>(&Wrappers::sepFilter2D_wrapper));

    function("sepFilter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, const cv::Mat&, Point, double)>(&Wrappers::sepFilter2D_wrapper_1));

    function("sepFilter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, const cv::Mat&, Point)>(&Wrappers::sepFilter2D_wrapper_2));

    function("sepFilter2D", select_overload<void(const cv::Mat&, cv::Mat&, int, const cv::Mat&, const cv::Mat&)>(&Wrappers::sepFilter2D_wrapper_3));

    function("setIdentity", select_overload<void(cv::Mat&, const Scalar&)>(&Wrappers::setIdentity_wrapper));

    function("setIdentity", select_overload<void(cv::Mat&)>(&Wrappers::setIdentity_wrapper_1));

    function("setRNGSeed", select_overload<void(int)>(&Wrappers::setRNGSeed_wrapper));

    function("solve", select_overload<bool(const cv::Mat&, const cv::Mat&, cv::Mat&, int)>(&Wrappers::solve_wrapper));

    function("solve", select_overload<bool(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::solve_wrapper_1));

    function("solvePnP", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool, int)>(&Wrappers::solvePnP_wrapper));

    function("solvePnP", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool)>(&Wrappers::solvePnP_wrapper_1));

    function("solvePnP", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::solvePnP_wrapper_2));

    function("solvePnPRansac", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool, int, float, double, cv::Mat&, int)>(&Wrappers::solvePnPRansac_wrapper));

    function("solvePnPRansac", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool, int, float, double, cv::Mat&)>(&Wrappers::solvePnPRansac_wrapper_1));

    function("solvePnPRansac", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool, int, float, double)>(&Wrappers::solvePnPRansac_wrapper_2));

    function("solvePnPRansac", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool, int, float)>(&Wrappers::solvePnPRansac_wrapper_3));

    function("solvePnPRansac", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool, int)>(&Wrappers::solvePnPRansac_wrapper_4));

    function("solvePnPRansac", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, bool)>(&Wrappers::solvePnPRansac_wrapper_5));

    function("solvePnPRansac", select_overload<bool(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::solvePnPRansac_wrapper_6));

    function("solvePnPRansac1", select_overload<bool(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&, const UsacParams&)>(&Wrappers::solvePnPRansac_wrapper1));

    function("solvePnPRansac1", select_overload<bool(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::solvePnPRansac_wrapper1_1));

    function("solvePnPRefineLM", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&, TermCriteria)>(&Wrappers::solvePnPRefineLM_wrapper));

    function("solvePnPRefineLM", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::solvePnPRefineLM_wrapper_1));

    function("solvePoly", select_overload<double(const cv::Mat&, cv::Mat&, int)>(&Wrappers::solvePoly_wrapper));

    function("solvePoly", select_overload<double(const cv::Mat&, cv::Mat&)>(&Wrappers::solvePoly_wrapper_1));

    function("spatialGradient", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&, int, int)>(&Wrappers::spatialGradient_wrapper));

    function("spatialGradient", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&, int)>(&Wrappers::spatialGradient_wrapper_1));

    function("spatialGradient", select_overload<void(const cv::Mat&, cv::Mat&, cv::Mat&)>(&Wrappers::spatialGradient_wrapper_2));

    function("split", select_overload<void(const cv::Mat&, std::vector<cv::Mat>&)>(&Wrappers::split_wrapper));

    function("sqrBoxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size, Point, bool, int)>(&Wrappers::sqrBoxFilter_wrapper));

    function("sqrBoxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size, Point, bool)>(&Wrappers::sqrBoxFilter_wrapper_1));

    function("sqrBoxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size, Point)>(&Wrappers::sqrBoxFilter_wrapper_2));

    function("sqrBoxFilter", select_overload<void(const cv::Mat&, cv::Mat&, int, Size)>(&Wrappers::sqrBoxFilter_wrapper_3));

    function("sqrt", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::sqrt_wrapper));

    function("stackBlur", select_overload<void(const cv::Mat&, cv::Mat&, Size)>(&Wrappers::stackBlur_wrapper));

    function("subtract", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&, int)>(&Wrappers::subtract_wrapper));

    function("subtract", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::subtract_wrapper_1));

    function("subtract", select_overload<void(const cv::Mat&, const cv::Mat&, cv::Mat&)>(&Wrappers::subtract_wrapper_2));

    function("threshold", select_overload<double(const cv::Mat&, cv::Mat&, double, double, int)>(&Wrappers::threshold_wrapper));

    function("trace", select_overload<Scalar(const cv::Mat&)>(&Wrappers::trace_wrapper));

    function("transform", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&)>(&Wrappers::transform_wrapper));

    function("transpose", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::transpose_wrapper));

    function("undistort", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&)>(&Wrappers::undistort_wrapper));

    function("undistort", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&)>(&Wrappers::undistort_wrapper_1));

    function("vconcat", select_overload<void(const std::vector<cv::Mat>&, cv::Mat&)>(&Wrappers::vconcat_wrapper));

    function("warpAffine", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size, int, int, const Scalar&)>(&Wrappers::warpAffine_wrapper));

    function("warpAffine", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size, int, int)>(&Wrappers::warpAffine_wrapper_1));

    function("warpAffine", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size, int)>(&Wrappers::warpAffine_wrapper_2));

    function("warpAffine", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size)>(&Wrappers::warpAffine_wrapper_3));

    function("warpPerspective", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size, int, int, const Scalar&)>(&Wrappers::warpPerspective_wrapper));

    function("warpPerspective", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size, int, int)>(&Wrappers::warpPerspective_wrapper_1));

    function("warpPerspective", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size, int)>(&Wrappers::warpPerspective_wrapper_2));

    function("warpPerspective", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, Size)>(&Wrappers::warpPerspective_wrapper_3));

    function("warpPolar", select_overload<void(const cv::Mat&, cv::Mat&, Size, Point2f, double, int)>(&Wrappers::warpPolar_wrapper));

    function("watershed", select_overload<void(const cv::Mat&, cv::Mat&)>(&Wrappers::watershed_wrapper));

    function("drawDetectedCornersCharuco", select_overload<void(cv::Mat&, const cv::Mat&, const cv::Mat&, Scalar)>(&Wrappers::drawDetectedCornersCharuco_wrapper));

    function("drawDetectedCornersCharuco", select_overload<void(cv::Mat&, const cv::Mat&, const cv::Mat&)>(&Wrappers::drawDetectedCornersCharuco_wrapper_1));

    function("drawDetectedCornersCharuco", select_overload<void(cv::Mat&, const cv::Mat&)>(&Wrappers::drawDetectedCornersCharuco_wrapper_2));

    function("drawDetectedDiamonds", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const cv::Mat&, Scalar)>(&Wrappers::drawDetectedDiamonds_wrapper));

    function("drawDetectedDiamonds", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const cv::Mat&)>(&Wrappers::drawDetectedDiamonds_wrapper_1));

    function("drawDetectedDiamonds", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&)>(&Wrappers::drawDetectedDiamonds_wrapper_2));

    function("drawDetectedMarkers", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const cv::Mat&, Scalar)>(&Wrappers::drawDetectedMarkers_wrapper));

    function("drawDetectedMarkers", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&, const cv::Mat&)>(&Wrappers::drawDetectedMarkers_wrapper_1));

    function("drawDetectedMarkers", select_overload<void(cv::Mat&, const std::vector<cv::Mat>&)>(&Wrappers::drawDetectedMarkers_wrapper_2));

    function("extendDictionary", select_overload<Dictionary(int, int, const Dictionary&, int)>(&Wrappers::extendDictionary_wrapper));

    function("extendDictionary", select_overload<Dictionary(int, int, const Dictionary&)>(&Wrappers::extendDictionary_wrapper_1));

    function("extendDictionary", select_overload<Dictionary(int, int)>(&Wrappers::extendDictionary_wrapper_2));

    function("generateImageMarker", select_overload<void(const Dictionary&, int, int, cv::Mat&, int)>(&Wrappers::generateImageMarker_wrapper));

    function("generateImageMarker", select_overload<void(const Dictionary&, int, int, cv::Mat&)>(&Wrappers::generateImageMarker_wrapper_1));

    function("getPredefinedDictionary", select_overload<Dictionary(int)>(&Wrappers::getPredefinedDictionary_wrapper));

    function("blobFromImage", select_overload<Mat(const cv::Mat&, double, const Size&, const Scalar&, bool, bool, int)>(&Wrappers::blobFromImage_wrapper));

    function("blobFromImage", select_overload<Mat(const cv::Mat&, double, const Size&, const Scalar&, bool, bool)>(&Wrappers::blobFromImage_wrapper_1));

    function("blobFromImage", select_overload<Mat(const cv::Mat&, double, const Size&, const Scalar&, bool)>(&Wrappers::blobFromImage_wrapper_2));

    function("blobFromImage", select_overload<Mat(const cv::Mat&, double, const Size&, const Scalar&)>(&Wrappers::blobFromImage_wrapper_3));

    function("blobFromImage", select_overload<Mat(const cv::Mat&, double, const Size&)>(&Wrappers::blobFromImage_wrapper_4));

    function("blobFromImage", select_overload<Mat(const cv::Mat&, double)>(&Wrappers::blobFromImage_wrapper_5));

    function("blobFromImage", select_overload<Mat(const cv::Mat&)>(&Wrappers::blobFromImage_wrapper_6));

    function("readNet", select_overload<Net(const std::string&, const std::string&, const std::string&)>(&Wrappers::readNet_wrapper));

    function("readNet", select_overload<Net(const std::string&, const std::string&)>(&Wrappers::readNet_wrapper_1));

    function("readNet", select_overload<Net(const std::string&)>(&Wrappers::readNet_wrapper_2));

    function("readNet1", select_overload<Net(const std::string&, const emscripten::val&, const emscripten::val&)>(&Wrappers::readNet_wrapper1));

    function("readNet1", select_overload<Net(const std::string&, const emscripten::val&)>(&Wrappers::readNet_wrapper1_1));

    function("readNetFromCaffe", select_overload<Net(const std::string&, const std::string&)>(&Wrappers::readNetFromCaffe_wrapper));

    function("readNetFromCaffe", select_overload<Net(const std::string&)>(&Wrappers::readNetFromCaffe_wrapper_1));

    function("readNetFromCaffe1", select_overload<Net(const emscripten::val&, const emscripten::val&)>(&Wrappers::readNetFromCaffe_wrapper1));

    function("readNetFromCaffe1", select_overload<Net(const emscripten::val&)>(&Wrappers::readNetFromCaffe_wrapper1_1));

    function("readNetFromDarknet", select_overload<Net(const std::string&, const std::string&)>(&Wrappers::readNetFromDarknet_wrapper));

    function("readNetFromDarknet", select_overload<Net(const std::string&)>(&Wrappers::readNetFromDarknet_wrapper_1));

    function("readNetFromDarknet1", select_overload<Net(const emscripten::val&, const emscripten::val&)>(&Wrappers::readNetFromDarknet_wrapper1));

    function("readNetFromDarknet1", select_overload<Net(const emscripten::val&)>(&Wrappers::readNetFromDarknet_wrapper1_1));

    function("readNetFromONNX", select_overload<Net(const std::string&)>(&Wrappers::readNetFromONNX_wrapper));

    function("readNetFromONNX1", select_overload<Net(const emscripten::val&)>(&Wrappers::readNetFromONNX_wrapper1));

    function("readNetFromTFLite", select_overload<Net(const std::string&)>(&Wrappers::readNetFromTFLite_wrapper));

    function("readNetFromTFLite1", select_overload<Net(const emscripten::val&)>(&Wrappers::readNetFromTFLite_wrapper1));

    function("readNetFromTensorflow", select_overload<Net(const std::string&, const std::string&)>(&Wrappers::readNetFromTensorflow_wrapper));

    function("readNetFromTensorflow", select_overload<Net(const std::string&)>(&Wrappers::readNetFromTensorflow_wrapper_1));

    function("readNetFromTensorflow1", select_overload<Net(const emscripten::val&, const emscripten::val&)>(&Wrappers::readNetFromTensorflow_wrapper1));

    function("readNetFromTensorflow1", select_overload<Net(const emscripten::val&)>(&Wrappers::readNetFromTensorflow_wrapper1_1));

    function("readNetFromTorch", select_overload<Net(const std::string&, bool, bool)>(&Wrappers::readNetFromTorch_wrapper));

    function("readNetFromTorch", select_overload<Net(const std::string&, bool)>(&Wrappers::readNetFromTorch_wrapper_1));

    function("readNetFromTorch", select_overload<Net(const std::string&)>(&Wrappers::readNetFromTorch_wrapper_2));

    function("fisheye_initUndistortRectifyMap", select_overload<void(const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const Size&, int, cv::Mat&, cv::Mat&)>(&Wrappers::fisheye_initUndistortRectifyMap_wrapper));

    function("fisheye_projectPoints", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, double, cv::Mat&)>(&Wrappers::fisheye_projectPoints_wrapper));

    function("fisheye_projectPoints", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, double)>(&Wrappers::fisheye_projectPoints_wrapper_1));

    function("fisheye_projectPoints", select_overload<void(const cv::Mat&, cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&, const cv::Mat&)>(&Wrappers::fisheye_projectPoints_wrapper_2));

    emscripten::class_<cv::AKAZE ,base<Feature2D>>("AKAZE")
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType,int,int,float,int,int,cv::KAZE::DiffusivityType,int)>(&Wrappers::AKAZE_create_wrapper))
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType,int,int,float,int,int,cv::KAZE::DiffusivityType)>(&Wrappers::AKAZE_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType,int,int,float,int,int)>(&Wrappers::AKAZE_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType,int,int,float,int)>(&Wrappers::AKAZE_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType,int,int,float)>(&Wrappers::AKAZE_create_wrapper_4))
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType,int,int)>(&Wrappers::AKAZE_create_wrapper_5))
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType,int)>(&Wrappers::AKAZE_create_wrapper_6))
        .constructor(select_overload<Ptr<cv::AKAZE>(cv::AKAZE::DescriptorType)>(&Wrappers::AKAZE_create_wrapper_7))
        .constructor(select_overload<Ptr<cv::AKAZE>()>(&Wrappers::AKAZE_create_wrapper_8))
        .function("getDefaultName", select_overload<String(cv::AKAZE&)>(&Wrappers::AKAZE_getDefaultName_wrapper))
        .function("getDescriptorChannels", select_overload<int()const>(&cv::AKAZE::getDescriptorChannels), pure_virtual())
        .function("getDescriptorSize", select_overload<int()const>(&cv::AKAZE::getDescriptorSize), pure_virtual())
        .function("getDescriptorType", select_overload<cv::AKAZE::DescriptorType()const>(&cv::AKAZE::getDescriptorType), pure_virtual())
        .function("getDiffusivity", select_overload<cv::KAZE::DiffusivityType()const>(&cv::AKAZE::getDiffusivity), pure_virtual())
        .function("getNOctaveLayers", select_overload<int()const>(&cv::AKAZE::getNOctaveLayers), pure_virtual())
        .function("getNOctaves", select_overload<int()const>(&cv::AKAZE::getNOctaves), pure_virtual())
        .function("getThreshold", select_overload<double()const>(&cv::AKAZE::getThreshold), pure_virtual())
        .function("setDescriptorChannels", select_overload<void(cv::AKAZE&,int)>(&Wrappers::AKAZE_setDescriptorChannels_wrapper), pure_virtual())
        .function("setDescriptorSize", select_overload<void(cv::AKAZE&,int)>(&Wrappers::AKAZE_setDescriptorSize_wrapper), pure_virtual())
        .function("setDescriptorType", select_overload<void(cv::AKAZE&,cv::AKAZE::DescriptorType)>(&Wrappers::AKAZE_setDescriptorType_wrapper), pure_virtual())
        .function("setDiffusivity", select_overload<void(cv::AKAZE&,cv::KAZE::DiffusivityType)>(&Wrappers::AKAZE_setDiffusivity_wrapper), pure_virtual())
        .function("setNOctaveLayers", select_overload<void(cv::AKAZE&,int)>(&Wrappers::AKAZE_setNOctaveLayers_wrapper), pure_virtual())
        .function("setNOctaves", select_overload<void(cv::AKAZE&,int)>(&Wrappers::AKAZE_setNOctaves_wrapper), pure_virtual())
        .function("setThreshold", select_overload<void(cv::AKAZE&,double)>(&Wrappers::AKAZE_setThreshold_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::AKAZE>>("Ptr<AKAZE>")
;

    emscripten::class_<cv::AgastFeatureDetector ,base<Feature2D>>("AgastFeatureDetector")
        .constructor(select_overload<Ptr<cv::AgastFeatureDetector>(int,bool,cv::AgastFeatureDetector::DetectorType)>(&Wrappers::AgastFeatureDetector_create_wrapper))
        .constructor(select_overload<Ptr<cv::AgastFeatureDetector>(int,bool)>(&Wrappers::AgastFeatureDetector_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::AgastFeatureDetector>(int)>(&Wrappers::AgastFeatureDetector_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::AgastFeatureDetector>()>(&Wrappers::AgastFeatureDetector_create_wrapper_3))
        .function("getDefaultName", select_overload<String(cv::AgastFeatureDetector&)>(&Wrappers::AgastFeatureDetector_getDefaultName_wrapper))
        .function("getNonmaxSuppression", select_overload<bool()const>(&cv::AgastFeatureDetector::getNonmaxSuppression), pure_virtual())
        .function("getThreshold", select_overload<int()const>(&cv::AgastFeatureDetector::getThreshold), pure_virtual())
        .function("getType", select_overload<cv::AgastFeatureDetector::DetectorType()const>(&cv::AgastFeatureDetector::getType), pure_virtual())
        .function("setNonmaxSuppression", select_overload<void(cv::AgastFeatureDetector&,bool)>(&Wrappers::AgastFeatureDetector_setNonmaxSuppression_wrapper), pure_virtual())
        .function("setThreshold", select_overload<void(cv::AgastFeatureDetector&,int)>(&Wrappers::AgastFeatureDetector_setThreshold_wrapper), pure_virtual())
        .function("setType", select_overload<void(cv::AgastFeatureDetector&,cv::AgastFeatureDetector::DetectorType)>(&Wrappers::AgastFeatureDetector_setType_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::AgastFeatureDetector>>("Ptr<AgastFeatureDetector>")
;

    emscripten::class_<cv::Algorithm >("Algorithm");

    emscripten::class_<cv::AlignExposures ,base<Algorithm>>("AlignExposures")
        .function("process", select_overload<void(cv::AlignExposures&,const std::vector<cv::Mat>&,std::vector<cv::Mat>&&,const cv::Mat&,const cv::Mat&)>(&Wrappers::AlignExposures_process_wrapper), pure_virtual());

    emscripten::class_<cv::AlignMTB ,base<AlignExposures>>("AlignMTB")
        .constructor(select_overload<Ptr<cv::AlignMTB>(int,int,bool)>(&Wrappers::_createAlignMTB_wrapper))
        .constructor(select_overload<Ptr<cv::AlignMTB>(int,int)>(&Wrappers::_createAlignMTB_wrapper_1))
        .constructor(select_overload<Ptr<cv::AlignMTB>(int)>(&Wrappers::_createAlignMTB_wrapper_2))
        .constructor(select_overload<Ptr<cv::AlignMTB>()>(&Wrappers::_createAlignMTB_wrapper_3))
        .function("calculateShift", select_overload<Point(cv::AlignMTB&,const cv::Mat&,const cv::Mat&)>(&Wrappers::AlignMTB_calculateShift_wrapper), pure_virtual())
        .function("computeBitmaps", select_overload<void(cv::AlignMTB&,const cv::Mat&,cv::Mat&,cv::Mat&)>(&Wrappers::AlignMTB_computeBitmaps_wrapper), pure_virtual())
        .function("getCut", select_overload<bool()const>(&cv::AlignMTB::getCut), pure_virtual())
        .function("getExcludeRange", select_overload<int()const>(&cv::AlignMTB::getExcludeRange), pure_virtual())
        .function("getMaxBits", select_overload<int()const>(&cv::AlignMTB::getMaxBits), pure_virtual())
        .function("setCut", select_overload<void(cv::AlignMTB&,bool)>(&Wrappers::AlignMTB_setCut_wrapper), pure_virtual())
        .function("setExcludeRange", select_overload<void(cv::AlignMTB&,int)>(&Wrappers::AlignMTB_setExcludeRange_wrapper), pure_virtual())
        .function("setMaxBits", select_overload<void(cv::AlignMTB&,int)>(&Wrappers::AlignMTB_setMaxBits_wrapper), pure_virtual())
        .function("shiftMat", select_overload<void(cv::AlignMTB&,const cv::Mat&,cv::Mat&,const Point)>(&Wrappers::AlignMTB_shiftMat_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::AlignMTB>>("Ptr<AlignMTB>")
;

    emscripten::class_<cv::BFMatcher ,base<DescriptorMatcher>>("BFMatcher")
        .constructor(select_overload<Ptr<cv::BFMatcher>(int,bool)>(&Wrappers::BFMatcher_create_wrapper))
        .constructor(select_overload<Ptr<cv::BFMatcher>(int)>(&Wrappers::BFMatcher_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::BFMatcher>()>(&Wrappers::BFMatcher_create_wrapper_2))
        .smart_ptr<Ptr<cv::BFMatcher>>("Ptr<BFMatcher>")
;

    emscripten::class_<cv::BRISK ,base<Feature2D>>("BRISK")
        .constructor(select_overload<Ptr<cv::BRISK>(int,int,float)>(&Wrappers::BRISK_create_wrapper))
        .constructor(select_overload<Ptr<cv::BRISK>(int,int)>(&Wrappers::BRISK_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::BRISK>(int)>(&Wrappers::BRISK_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::BRISK>()>(&Wrappers::BRISK_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::BRISK>(const emscripten::val&,const emscripten::val&,float,float,const emscripten::val&)>(&Wrappers::BRISK_create_wrapper1))
        .constructor(select_overload<Ptr<cv::BRISK>(const emscripten::val&,const emscripten::val&,float,float)>(&Wrappers::BRISK_create_wrapper1_1))
        .constructor(select_overload<Ptr<cv::BRISK>(int,int,const emscripten::val&,const emscripten::val&,float,float,const emscripten::val&)>(&Wrappers::BRISK_create_wrapper2))
        .constructor(select_overload<Ptr<cv::BRISK>(int,int,const emscripten::val&,const emscripten::val&,float,float)>(&Wrappers::BRISK_create_wrapper2_1))
        .function("getDefaultName", select_overload<String(cv::BRISK&)>(&Wrappers::BRISK_getDefaultName_wrapper))
        .smart_ptr<Ptr<cv::BRISK>>("Ptr<BRISK>")
;

    emscripten::class_<cv::BackgroundSubtractor ,base<Algorithm>>("BackgroundSubtractor")
        .function("apply", select_overload<void(cv::BackgroundSubtractor&,const cv::Mat&,cv::Mat&,double)>(&Wrappers::BackgroundSubtractor_apply_wrapper), pure_virtual())
        .function("apply", select_overload<void(cv::BackgroundSubtractor&,const cv::Mat&,cv::Mat&)>(&Wrappers::BackgroundSubtractor_apply_wrapper_1), pure_virtual())
        .function("apply1", select_overload<void(cv::BackgroundSubtractor&,const cv::Mat&,const cv::Mat&,cv::Mat&,double)>(&Wrappers::BackgroundSubtractor_apply_wrapper1), pure_virtual())
        .function("apply1", select_overload<void(cv::BackgroundSubtractor&,const cv::Mat&,const cv::Mat&,cv::Mat&)>(&Wrappers::BackgroundSubtractor_apply_wrapper1_1), pure_virtual())
        .function("getBackgroundImage", select_overload<void(cv::BackgroundSubtractor&,cv::Mat&)>(&Wrappers::BackgroundSubtractor_getBackgroundImage_wrapper), pure_virtual());

    emscripten::class_<cv::BackgroundSubtractorMOG2 ,base<BackgroundSubtractor>>("BackgroundSubtractorMOG2")
        .constructor(select_overload<Ptr<cv::BackgroundSubtractorMOG2>(int,double,bool)>(&Wrappers::_createBackgroundSubtractorMOG2_wrapper))
        .constructor(select_overload<Ptr<cv::BackgroundSubtractorMOG2>(int,double)>(&Wrappers::_createBackgroundSubtractorMOG2_wrapper_1))
        .constructor(select_overload<Ptr<cv::BackgroundSubtractorMOG2>(int)>(&Wrappers::_createBackgroundSubtractorMOG2_wrapper_2))
        .constructor(select_overload<Ptr<cv::BackgroundSubtractorMOG2>()>(&Wrappers::_createBackgroundSubtractorMOG2_wrapper_3))
        .function("apply", select_overload<void(cv::BackgroundSubtractorMOG2&,const cv::Mat&,cv::Mat&,double)>(&Wrappers::BackgroundSubtractorMOG2_apply_wrapper), pure_virtual())
        .function("apply", select_overload<void(cv::BackgroundSubtractorMOG2&,const cv::Mat&,cv::Mat&)>(&Wrappers::BackgroundSubtractorMOG2_apply_wrapper_1), pure_virtual())
        .function("apply1", select_overload<void(cv::BackgroundSubtractorMOG2&,const cv::Mat&,const cv::Mat&,cv::Mat&,double)>(&Wrappers::BackgroundSubtractorMOG2_apply_wrapper1), pure_virtual())
        .function("apply1", select_overload<void(cv::BackgroundSubtractorMOG2&,const cv::Mat&,const cv::Mat&,cv::Mat&)>(&Wrappers::BackgroundSubtractorMOG2_apply_wrapper1_1), pure_virtual())
        .smart_ptr<Ptr<cv::BackgroundSubtractorMOG2>>("Ptr<BackgroundSubtractorMOG2>")
;

    emscripten::class_<cv::CLAHE ,base<Algorithm>>("CLAHE")
        .constructor(select_overload<Ptr<cv::CLAHE>(double,Size)>(&Wrappers::_createCLAHE_wrapper))
        .constructor(select_overload<Ptr<cv::CLAHE>(double)>(&Wrappers::_createCLAHE_wrapper_1))
        .constructor(select_overload<Ptr<cv::CLAHE>()>(&Wrappers::_createCLAHE_wrapper_2))
        .function("apply", select_overload<void(cv::CLAHE&,const cv::Mat&,cv::Mat&)>(&Wrappers::CLAHE_apply_wrapper), pure_virtual())
        .function("collectGarbage", select_overload<void()>(&cv::CLAHE::collectGarbage), pure_virtual())
        .function("getClipLimit", select_overload<double()const>(&cv::CLAHE::getClipLimit), pure_virtual())
        .function("getTilesGridSize", select_overload<Size()const>(&cv::CLAHE::getTilesGridSize), pure_virtual())
        .function("setClipLimit", select_overload<void(cv::CLAHE&,double)>(&Wrappers::CLAHE_setClipLimit_wrapper), pure_virtual())
        .function("setTilesGridSize", select_overload<void(cv::CLAHE&,Size)>(&Wrappers::CLAHE_setTilesGridSize_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::CLAHE>>("Ptr<CLAHE>")
;

    emscripten::class_<cv::CalibrateCRF ,base<Algorithm>>("CalibrateCRF")
        .function("process", select_overload<void(cv::CalibrateCRF&,const std::vector<cv::Mat>&,cv::Mat&,const cv::Mat&)>(&Wrappers::CalibrateCRF_process_wrapper), pure_virtual());

    emscripten::class_<cv::CalibrateDebevec ,base<CalibrateCRF>>("CalibrateDebevec")
        .constructor(select_overload<Ptr<cv::CalibrateDebevec>(int,float,bool)>(&Wrappers::_createCalibrateDebevec_wrapper))
        .constructor(select_overload<Ptr<cv::CalibrateDebevec>(int,float)>(&Wrappers::_createCalibrateDebevec_wrapper_1))
        .constructor(select_overload<Ptr<cv::CalibrateDebevec>(int)>(&Wrappers::_createCalibrateDebevec_wrapper_2))
        .constructor(select_overload<Ptr<cv::CalibrateDebevec>()>(&Wrappers::_createCalibrateDebevec_wrapper_3))
        .function("getLambda", select_overload<float()const>(&cv::CalibrateDebevec::getLambda), pure_virtual())
        .function("getRandom", select_overload<bool()const>(&cv::CalibrateDebevec::getRandom), pure_virtual())
        .function("getSamples", select_overload<int()const>(&cv::CalibrateDebevec::getSamples), pure_virtual())
        .function("setLambda", select_overload<void(cv::CalibrateDebevec&,float)>(&Wrappers::CalibrateDebevec_setLambda_wrapper), pure_virtual())
        .function("setRandom", select_overload<void(cv::CalibrateDebevec&,bool)>(&Wrappers::CalibrateDebevec_setRandom_wrapper), pure_virtual())
        .function("setSamples", select_overload<void(cv::CalibrateDebevec&,int)>(&Wrappers::CalibrateDebevec_setSamples_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::CalibrateDebevec>>("Ptr<CalibrateDebevec>")
;

    emscripten::class_<cv::CalibrateRobertson ,base<CalibrateCRF>>("CalibrateRobertson")
        .constructor(select_overload<Ptr<cv::CalibrateRobertson>(int,float)>(&Wrappers::_createCalibrateRobertson_wrapper))
        .constructor(select_overload<Ptr<cv::CalibrateRobertson>(int)>(&Wrappers::_createCalibrateRobertson_wrapper_1))
        .constructor(select_overload<Ptr<cv::CalibrateRobertson>()>(&Wrappers::_createCalibrateRobertson_wrapper_2))
        .function("getMaxIter", select_overload<int()const>(&cv::CalibrateRobertson::getMaxIter), pure_virtual())
        .function("getRadiance", select_overload<Mat()const>(&cv::CalibrateRobertson::getRadiance), pure_virtual())
        .function("getThreshold", select_overload<float()const>(&cv::CalibrateRobertson::getThreshold), pure_virtual())
        .function("setMaxIter", select_overload<void(cv::CalibrateRobertson&,int)>(&Wrappers::CalibrateRobertson_setMaxIter_wrapper), pure_virtual())
        .function("setThreshold", select_overload<void(cv::CalibrateRobertson&,float)>(&Wrappers::CalibrateRobertson_setThreshold_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::CalibrateRobertson>>("Ptr<CalibrateRobertson>")
;

    emscripten::class_<cv::CascadeClassifier >("CascadeClassifier")
        .constructor<>()
        .constructor<const std::string&>()
        .function("detectMultiScale", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,double,int,int,Size,Size)>(&Wrappers::CascadeClassifier_detectMultiScale_wrapper))
        .function("detectMultiScale", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,double,int,int,Size)>(&Wrappers::CascadeClassifier_detectMultiScale_wrapper_1))
        .function("detectMultiScale", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,double,int,int)>(&Wrappers::CascadeClassifier_detectMultiScale_wrapper_2))
        .function("detectMultiScale", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,double,int)>(&Wrappers::CascadeClassifier_detectMultiScale_wrapper_3))
        .function("detectMultiScale", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,double)>(&Wrappers::CascadeClassifier_detectMultiScale_wrapper_4))
        .function("detectMultiScale", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&)>(&Wrappers::CascadeClassifier_detectMultiScale_wrapper_5))
        .function("detectMultiScale2", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,double,int,int,Size,Size)>(&Wrappers::CascadeClassifier_detectMultiScale2_wrapper))
        .function("detectMultiScale2", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,double,int,int,Size)>(&Wrappers::CascadeClassifier_detectMultiScale2_wrapper_1))
        .function("detectMultiScale2", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,double,int,int)>(&Wrappers::CascadeClassifier_detectMultiScale2_wrapper_2))
        .function("detectMultiScale2", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,double,int)>(&Wrappers::CascadeClassifier_detectMultiScale2_wrapper_3))
        .function("detectMultiScale2", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,double)>(&Wrappers::CascadeClassifier_detectMultiScale2_wrapper_4))
        .function("detectMultiScale2", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&)>(&Wrappers::CascadeClassifier_detectMultiScale2_wrapper_5))
        .function("detectMultiScale3", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,std::vector<double>&,double,int,int,Size,Size,bool)>(&Wrappers::CascadeClassifier_detectMultiScale3_wrapper))
        .function("detectMultiScale3", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,std::vector<double>&,double,int,int,Size,Size)>(&Wrappers::CascadeClassifier_detectMultiScale3_wrapper_1))
        .function("detectMultiScale3", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,std::vector<double>&,double,int,int,Size)>(&Wrappers::CascadeClassifier_detectMultiScale3_wrapper_2))
        .function("detectMultiScale3", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,std::vector<double>&,double,int,int)>(&Wrappers::CascadeClassifier_detectMultiScale3_wrapper_3))
        .function("detectMultiScale3", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,std::vector<double>&,double,int)>(&Wrappers::CascadeClassifier_detectMultiScale3_wrapper_4))
        .function("detectMultiScale3", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,std::vector<double>&,double)>(&Wrappers::CascadeClassifier_detectMultiScale3_wrapper_5))
        .function("detectMultiScale3", select_overload<void(cv::CascadeClassifier&,const cv::Mat&,std::vector<Rect>&,std::vector<int>&,std::vector<double>&)>(&Wrappers::CascadeClassifier_detectMultiScale3_wrapper_6))
        .function("empty", select_overload<bool()const>(&cv::CascadeClassifier::empty))
        .function("load", select_overload<bool(cv::CascadeClassifier&,const std::string&)>(&Wrappers::CascadeClassifier_load_wrapper));

    emscripten::class_<cv::DescriptorMatcher ,base<Algorithm>>("DescriptorMatcher")
        .function("add", select_overload<void(cv::DescriptorMatcher&,const std::vector<cv::Mat>&)>(&Wrappers::DescriptorMatcher_add_wrapper))
        .function("clear", select_overload<void()>(&cv::DescriptorMatcher::clear))
        .constructor(select_overload<Ptr<cv::DescriptorMatcher>(const std::string&)>(&Wrappers::DescriptorMatcher_create_wrapper))
        .function("empty", select_overload<bool()const>(&cv::DescriptorMatcher::empty))
        .function("isMaskSupported", select_overload<bool()const>(&cv::DescriptorMatcher::isMaskSupported), pure_virtual())
        .function("knnMatch", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<std::vector<DMatch>>&,int,const cv::Mat&,bool)>(&Wrappers::DescriptorMatcher_knnMatch_wrapper))
        .function("knnMatch", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<std::vector<DMatch>>&,int,const cv::Mat&)>(&Wrappers::DescriptorMatcher_knnMatch_wrapper_1))
        .function("knnMatch", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<std::vector<DMatch>>&,int)>(&Wrappers::DescriptorMatcher_knnMatch_wrapper_2))
        .function("knnMatch1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<std::vector<DMatch>>&,int,const std::vector<cv::Mat>&,bool)>(&Wrappers::DescriptorMatcher_knnMatch_wrapper1))
        .function("knnMatch1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<std::vector<DMatch>>&,int,const std::vector<cv::Mat>&)>(&Wrappers::DescriptorMatcher_knnMatch_wrapper1_1))
        .function("knnMatch1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<std::vector<DMatch>>&,int)>(&Wrappers::DescriptorMatcher_knnMatch_wrapper1_2))
        .function("match", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<DMatch>&,const cv::Mat&)>(&Wrappers::DescriptorMatcher_match_wrapper))
        .function("match", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<DMatch>&)>(&Wrappers::DescriptorMatcher_match_wrapper_1))
        .function("match1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<DMatch>&,const std::vector<cv::Mat>&)>(&Wrappers::DescriptorMatcher_match_wrapper1))
        .function("match1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<DMatch>&)>(&Wrappers::DescriptorMatcher_match_wrapper1_1))
        .function("radiusMatch", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<std::vector<DMatch>>&,float,const cv::Mat&,bool)>(&Wrappers::DescriptorMatcher_radiusMatch_wrapper))
        .function("radiusMatch", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<std::vector<DMatch>>&,float,const cv::Mat&)>(&Wrappers::DescriptorMatcher_radiusMatch_wrapper_1))
        .function("radiusMatch", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,const cv::Mat&,std::vector<std::vector<DMatch>>&,float)>(&Wrappers::DescriptorMatcher_radiusMatch_wrapper_2))
        .function("radiusMatch1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<std::vector<DMatch>>&,float,const std::vector<cv::Mat>&,bool)>(&Wrappers::DescriptorMatcher_radiusMatch_wrapper1))
        .function("radiusMatch1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<std::vector<DMatch>>&,float,const std::vector<cv::Mat>&)>(&Wrappers::DescriptorMatcher_radiusMatch_wrapper1_1))
        .function("radiusMatch1", select_overload<void(cv::DescriptorMatcher&,const cv::Mat&,std::vector<std::vector<DMatch>>&,float)>(&Wrappers::DescriptorMatcher_radiusMatch_wrapper1_2))
        .function("train", select_overload<void()>(&cv::DescriptorMatcher::train))
        .smart_ptr<Ptr<cv::DescriptorMatcher>>("Ptr<DescriptorMatcher>")
;

    emscripten::class_<cv::FaceDetectorYN >("FaceDetectorYN")
        .constructor(select_overload<Ptr<cv::FaceDetectorYN>(const std::string&,const std::string&,const Size&,float,float,int,int,int)>(&Wrappers::FaceDetectorYN_create_wrapper))
        .constructor(select_overload<Ptr<cv::FaceDetectorYN>(const std::string&,const std::string&,const Size&,float,float,int,int)>(&Wrappers::FaceDetectorYN_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::FaceDetectorYN>(const std::string&,const std::string&,const Size&,float,float,int)>(&Wrappers::FaceDetectorYN_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::FaceDetectorYN>(const std::string&,const std::string&,const Size&,float,float)>(&Wrappers::FaceDetectorYN_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::FaceDetectorYN>(const std::string&,const std::string&,const Size&,float)>(&Wrappers::FaceDetectorYN_create_wrapper_4))
        .constructor(select_overload<Ptr<cv::FaceDetectorYN>(const std::string&,const std::string&,const Size&)>(&Wrappers::FaceDetectorYN_create_wrapper_5))
        .constructor(select_overload<Ptr<cv::FaceDetectorYN>(const std::string&,const emscripten::val&,const emscripten::val&,const Size&,float,float,int,int,int)>(&Wrappers::FaceDetectorYN_create_wrapper1))
        .function("detect", select_overload<int(cv::FaceDetectorYN&,const cv::Mat&,cv::Mat&)>(&Wrappers::FaceDetectorYN_detect_wrapper), pure_virtual())
        .function("getInputSize", select_overload<Size()>(&cv::FaceDetectorYN::getInputSize), pure_virtual())
        .function("getNMSThreshold", select_overload<float()>(&cv::FaceDetectorYN::getNMSThreshold), pure_virtual())
        .function("getScoreThreshold", select_overload<float()>(&cv::FaceDetectorYN::getScoreThreshold), pure_virtual())
        .function("getTopK", select_overload<int()>(&cv::FaceDetectorYN::getTopK), pure_virtual())
        .function("setInputSize", select_overload<void(cv::FaceDetectorYN&,const Size&)>(&Wrappers::FaceDetectorYN_setInputSize_wrapper), pure_virtual())
        .function("setNMSThreshold", select_overload<void(cv::FaceDetectorYN&,float)>(&Wrappers::FaceDetectorYN_setNMSThreshold_wrapper), pure_virtual())
        .function("setScoreThreshold", select_overload<void(cv::FaceDetectorYN&,float)>(&Wrappers::FaceDetectorYN_setScoreThreshold_wrapper), pure_virtual())
        .function("setTopK", select_overload<void(cv::FaceDetectorYN&,int)>(&Wrappers::FaceDetectorYN_setTopK_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::FaceDetectorYN>>("Ptr<FaceDetectorYN>")
;

    emscripten::class_<cv::FastFeatureDetector ,base<Feature2D>>("FastFeatureDetector")
        .constructor(select_overload<Ptr<cv::FastFeatureDetector>(int,bool,cv::FastFeatureDetector::DetectorType)>(&Wrappers::FastFeatureDetector_create_wrapper))
        .constructor(select_overload<Ptr<cv::FastFeatureDetector>(int,bool)>(&Wrappers::FastFeatureDetector_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::FastFeatureDetector>(int)>(&Wrappers::FastFeatureDetector_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::FastFeatureDetector>()>(&Wrappers::FastFeatureDetector_create_wrapper_3))
        .function("getDefaultName", select_overload<String(cv::FastFeatureDetector&)>(&Wrappers::FastFeatureDetector_getDefaultName_wrapper))
        .function("getNonmaxSuppression", select_overload<bool()const>(&cv::FastFeatureDetector::getNonmaxSuppression), pure_virtual())
        .function("getThreshold", select_overload<int()const>(&cv::FastFeatureDetector::getThreshold), pure_virtual())
        .function("getType", select_overload<cv::FastFeatureDetector::DetectorType()const>(&cv::FastFeatureDetector::getType), pure_virtual())
        .function("setNonmaxSuppression", select_overload<void(cv::FastFeatureDetector&,bool)>(&Wrappers::FastFeatureDetector_setNonmaxSuppression_wrapper), pure_virtual())
        .function("setThreshold", select_overload<void(cv::FastFeatureDetector&,int)>(&Wrappers::FastFeatureDetector_setThreshold_wrapper), pure_virtual())
        .function("setType", select_overload<void(cv::FastFeatureDetector&,cv::FastFeatureDetector::DetectorType)>(&Wrappers::FastFeatureDetector_setType_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::FastFeatureDetector>>("Ptr<FastFeatureDetector>")
;

    emscripten::class_<cv::Feature2D ,base<Algorithm>>("Feature2D")
        .function("compute", select_overload<void(cv::Feature2D&,const cv::Mat&,std::vector<KeyPoint>&,cv::Mat&)>(&Wrappers::Feature2D_compute_wrapper))
        .function("compute1", select_overload<void(cv::Feature2D&,const std::vector<cv::Mat>&,std::vector<std::vector<KeyPoint>>&,std::vector<cv::Mat>&)>(&Wrappers::Feature2D_compute_wrapper1))
        .function("defaultNorm", select_overload<int()const>(&cv::Feature2D::defaultNorm))
        .function("descriptorSize", select_overload<int()const>(&cv::Feature2D::descriptorSize))
        .function("descriptorType", select_overload<int()const>(&cv::Feature2D::descriptorType))
        .function("detect", select_overload<void(cv::Feature2D&,const cv::Mat&,std::vector<KeyPoint>&,const cv::Mat&)>(&Wrappers::Feature2D_detect_wrapper))
        .function("detect", select_overload<void(cv::Feature2D&,const cv::Mat&,std::vector<KeyPoint>&)>(&Wrappers::Feature2D_detect_wrapper_1))
        .function("detect1", select_overload<void(cv::Feature2D&,const std::vector<cv::Mat>&,std::vector<std::vector<KeyPoint>>&,const std::vector<cv::Mat>&)>(&Wrappers::Feature2D_detect_wrapper1))
        .function("detect1", select_overload<void(cv::Feature2D&,const std::vector<cv::Mat>&,std::vector<std::vector<KeyPoint>>&)>(&Wrappers::Feature2D_detect_wrapper1_1))
        .function("detectAndCompute", select_overload<void(cv::Feature2D&,const cv::Mat&,const cv::Mat&,std::vector<KeyPoint>&,cv::Mat&,bool)>(&Wrappers::Feature2D_detectAndCompute_wrapper))
        .function("detectAndCompute", select_overload<void(cv::Feature2D&,const cv::Mat&,const cv::Mat&,std::vector<KeyPoint>&,cv::Mat&)>(&Wrappers::Feature2D_detectAndCompute_wrapper_1))
        .function("empty", select_overload<bool()const>(&cv::Feature2D::empty))
        .function("getDefaultName", select_overload<String(cv::Feature2D&)>(&Wrappers::Feature2D_getDefaultName_wrapper));

    emscripten::class_<cv::GFTTDetector ,base<Feature2D>>("GFTTDetector")
        .constructor(select_overload<Ptr<cv::GFTTDetector>(int,double,double,int,bool,double)>(&Wrappers::GFTTDetector_create_wrapper))
        .constructor(select_overload<Ptr<cv::GFTTDetector>(int,double,double,int,bool)>(&Wrappers::GFTTDetector_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::GFTTDetector>(int,double,double,int)>(&Wrappers::GFTTDetector_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::GFTTDetector>(int,double,double)>(&Wrappers::GFTTDetector_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::GFTTDetector>(int,double)>(&Wrappers::GFTTDetector_create_wrapper_4))
        .constructor(select_overload<Ptr<cv::GFTTDetector>(int)>(&Wrappers::GFTTDetector_create_wrapper_5))
        .constructor(select_overload<Ptr<cv::GFTTDetector>()>(&Wrappers::GFTTDetector_create_wrapper_6))
        .constructor(select_overload<Ptr<cv::GFTTDetector>(int,double,double,int,int,bool,double)>(&Wrappers::GFTTDetector_create_wrapper1))
        .function("getBlockSize", select_overload<int()const>(&cv::GFTTDetector::getBlockSize), pure_virtual())
        .function("getDefaultName", select_overload<String(cv::GFTTDetector&)>(&Wrappers::GFTTDetector_getDefaultName_wrapper))
        .function("getHarrisDetector", select_overload<bool()const>(&cv::GFTTDetector::getHarrisDetector), pure_virtual())
        .function("getK", select_overload<double()const>(&cv::GFTTDetector::getK), pure_virtual())
        .function("getMaxFeatures", select_overload<int()const>(&cv::GFTTDetector::getMaxFeatures), pure_virtual())
        .function("getMinDistance", select_overload<double()const>(&cv::GFTTDetector::getMinDistance), pure_virtual())
        .function("getQualityLevel", select_overload<double()const>(&cv::GFTTDetector::getQualityLevel), pure_virtual())
        .function("setBlockSize", select_overload<void(cv::GFTTDetector&,int)>(&Wrappers::GFTTDetector_setBlockSize_wrapper), pure_virtual())
        .function("setHarrisDetector", select_overload<void(cv::GFTTDetector&,bool)>(&Wrappers::GFTTDetector_setHarrisDetector_wrapper), pure_virtual())
        .function("setK", select_overload<void(cv::GFTTDetector&,double)>(&Wrappers::GFTTDetector_setK_wrapper), pure_virtual())
        .function("setMaxFeatures", select_overload<void(cv::GFTTDetector&,int)>(&Wrappers::GFTTDetector_setMaxFeatures_wrapper), pure_virtual())
        .function("setMinDistance", select_overload<void(cv::GFTTDetector&,double)>(&Wrappers::GFTTDetector_setMinDistance_wrapper), pure_virtual())
        .function("setQualityLevel", select_overload<void(cv::GFTTDetector&,double)>(&Wrappers::GFTTDetector_setQualityLevel_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::GFTTDetector>>("Ptr<GFTTDetector>")
;

    emscripten::class_<cv::GraphicalCodeDetector >("GraphicalCodeDetector")
        .function("decode", select_overload<string(cv::GraphicalCodeDetector&,const cv::Mat&,const cv::Mat&,cv::Mat&)>(&Wrappers::GraphicalCodeDetector_decode_wrapper))
        .function("decode", select_overload<string(cv::GraphicalCodeDetector&,const cv::Mat&,const cv::Mat&)>(&Wrappers::GraphicalCodeDetector_decode_wrapper_1))
        .function("decodeMulti", select_overload<bool(cv::GraphicalCodeDetector&,const cv::Mat&,const cv::Mat&,std::vector<string>&,std::vector<cv::Mat>&)>(&Wrappers::GraphicalCodeDetector_decodeMulti_wrapper))
        .function("decodeMulti", select_overload<bool(cv::GraphicalCodeDetector&,const cv::Mat&,const cv::Mat&,std::vector<string>&)>(&Wrappers::GraphicalCodeDetector_decodeMulti_wrapper_1))
        .function("detect", select_overload<bool(cv::GraphicalCodeDetector&,const cv::Mat&,cv::Mat&)>(&Wrappers::GraphicalCodeDetector_detect_wrapper))
        .function("detectAndDecode", select_overload<string(cv::GraphicalCodeDetector&,const cv::Mat&,cv::Mat&,cv::Mat&)>(&Wrappers::GraphicalCodeDetector_detectAndDecode_wrapper))
        .function("detectAndDecode", select_overload<string(cv::GraphicalCodeDetector&,const cv::Mat&,cv::Mat&)>(&Wrappers::GraphicalCodeDetector_detectAndDecode_wrapper_1))
        .function("detectAndDecode", select_overload<string(cv::GraphicalCodeDetector&,const cv::Mat&)>(&Wrappers::GraphicalCodeDetector_detectAndDecode_wrapper_2))
        .function("detectAndDecodeMulti", select_overload<bool(cv::GraphicalCodeDetector&,const cv::Mat&,std::vector<string>&,cv::Mat&,std::vector<cv::Mat>&)>(&Wrappers::GraphicalCodeDetector_detectAndDecodeMulti_wrapper))
        .function("detectAndDecodeMulti", select_overload<bool(cv::GraphicalCodeDetector&,const cv::Mat&,std::vector<string>&,cv::Mat&)>(&Wrappers::GraphicalCodeDetector_detectAndDecodeMulti_wrapper_1))
        .function("detectAndDecodeMulti", select_overload<bool(cv::GraphicalCodeDetector&,const cv::Mat&,std::vector<string>&)>(&Wrappers::GraphicalCodeDetector_detectAndDecodeMulti_wrapper_2))
        .function("detectMulti", select_overload<bool(cv::GraphicalCodeDetector&,const cv::Mat&,cv::Mat&)>(&Wrappers::GraphicalCodeDetector_detectMulti_wrapper));

    emscripten::class_<cv::HOGDescriptor >("HOGDescriptor")
        .constructor<>()
        .constructor<Size, Size, Size, Size, int, int, double, cv::HOGDescriptor::HistogramNormType, double, bool, int, bool>()
        .constructor<const std::string&>()
        .function("detectMultiScale", select_overload<void(cv::HOGDescriptor&,const cv::Mat&,std::vector<Rect>&,std::vector<double>&,double,Size,Size,double,double,bool)>(&Wrappers::HOGDescriptor_detectMultiScale_wrapper))
        .function("detectMultiScale", select_overload<void(cv::HOGDescriptor&,const cv::Mat&,std::vector<Rect>&,std::vector<double>&,double,Size,Size,double,double)>(&Wrappers::HOGDescriptor_detectMultiScale_wrapper_1))
        .function("detectMultiScale", select_overload<void(cv::HOGDescriptor&,const cv::Mat&,std::vector<Rect>&,std::vector<double>&,double,Size,Size,double)>(&Wrappers::HOGDescriptor_detectMultiScale_wrapper_2))
        .function("detectMultiScale", select_overload<void(cv::HOGDescriptor&,const cv::Mat&,std::vector<Rect>&,std::vector<double>&,double,Size,Size)>(&Wrappers::HOGDescriptor_detectMultiScale_wrapper_3))
        .function("detectMultiScale", select_overload<void(cv::HOGDescriptor&,const cv::Mat&,std::vector<Rect>&,std::vector<double>&,double,Size)>(&Wrappers::HOGDescriptor_detectMultiScale_wrapper_4))
        .function("detectMultiScale", select_overload<void(cv::HOGDescriptor&,const cv::Mat&,std::vector<Rect>&,std::vector<double>&,double)>(&Wrappers::HOGDescriptor_detectMultiScale_wrapper_5))
        .function("detectMultiScale", select_overload<void(cv::HOGDescriptor&,const cv::Mat&,std::vector<Rect>&,std::vector<double>&)>(&Wrappers::HOGDescriptor_detectMultiScale_wrapper_6))
        .class_function("getDaimlerPeopleDetector", select_overload<std::vector<float>()>(&cv::HOGDescriptor::getDaimlerPeopleDetector))
        .class_function("getDefaultPeopleDetector", select_overload<std::vector<float>()>(&cv::HOGDescriptor::getDefaultPeopleDetector))
        .function("load", select_overload<bool(cv::HOGDescriptor&,const std::string&,const std::string&)>(&Wrappers::HOGDescriptor_load_wrapper))
        .function("load", select_overload<bool(cv::HOGDescriptor&,const std::string&)>(&Wrappers::HOGDescriptor_load_wrapper_1))
        .function("setSVMDetector", select_overload<void(cv::HOGDescriptor&,const cv::Mat&)>(&Wrappers::HOGDescriptor_setSVMDetector_wrapper))
        .property("winSize", &cv::HOGDescriptor::winSize)
        .property("blockSize", &cv::HOGDescriptor::blockSize)
        .property("blockStride", &cv::HOGDescriptor::blockStride)
        .property("cellSize", &cv::HOGDescriptor::cellSize)
        .property("nbins", &cv::HOGDescriptor::nbins)
        .property("derivAperture", &cv::HOGDescriptor::derivAperture)
        .property("winSigma", &cv::HOGDescriptor::winSigma)
        .property("histogramNormType", binding_utils::underlying_ptr(&cv::HOGDescriptor::histogramNormType))
        .property("L2HysThreshold", &cv::HOGDescriptor::L2HysThreshold)
        .property("gammaCorrection", &cv::HOGDescriptor::gammaCorrection)
        .property("svmDetector", &cv::HOGDescriptor::svmDetector)
        .property("nlevels", &cv::HOGDescriptor::nlevels)
        .property("signedGradient", &cv::HOGDescriptor::signedGradient);

    emscripten::class_<cv::KAZE ,base<Feature2D>>("KAZE")
        .constructor(select_overload<Ptr<cv::KAZE>(bool,bool,float,int,int,cv::KAZE::DiffusivityType)>(&Wrappers::KAZE_create_wrapper))
        .constructor(select_overload<Ptr<cv::KAZE>(bool,bool,float,int,int)>(&Wrappers::KAZE_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::KAZE>(bool,bool,float,int)>(&Wrappers::KAZE_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::KAZE>(bool,bool,float)>(&Wrappers::KAZE_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::KAZE>(bool,bool)>(&Wrappers::KAZE_create_wrapper_4))
        .constructor(select_overload<Ptr<cv::KAZE>(bool)>(&Wrappers::KAZE_create_wrapper_5))
        .constructor(select_overload<Ptr<cv::KAZE>()>(&Wrappers::KAZE_create_wrapper_6))
        .function("getDefaultName", select_overload<String(cv::KAZE&)>(&Wrappers::KAZE_getDefaultName_wrapper))
        .function("getDiffusivity", select_overload<cv::KAZE::DiffusivityType()const>(&cv::KAZE::getDiffusivity), pure_virtual())
        .function("getExtended", select_overload<bool()const>(&cv::KAZE::getExtended), pure_virtual())
        .function("getNOctaveLayers", select_overload<int()const>(&cv::KAZE::getNOctaveLayers), pure_virtual())
        .function("getNOctaves", select_overload<int()const>(&cv::KAZE::getNOctaves), pure_virtual())
        .function("getThreshold", select_overload<double()const>(&cv::KAZE::getThreshold), pure_virtual())
        .function("getUpright", select_overload<bool()const>(&cv::KAZE::getUpright), pure_virtual())
        .function("setDiffusivity", select_overload<void(cv::KAZE&,cv::KAZE::DiffusivityType)>(&Wrappers::KAZE_setDiffusivity_wrapper), pure_virtual())
        .function("setExtended", select_overload<void(cv::KAZE&,bool)>(&Wrappers::KAZE_setExtended_wrapper), pure_virtual())
        .function("setNOctaveLayers", select_overload<void(cv::KAZE&,int)>(&Wrappers::KAZE_setNOctaveLayers_wrapper), pure_virtual())
        .function("setNOctaves", select_overload<void(cv::KAZE&,int)>(&Wrappers::KAZE_setNOctaves_wrapper), pure_virtual())
        .function("setThreshold", select_overload<void(cv::KAZE&,double)>(&Wrappers::KAZE_setThreshold_wrapper), pure_virtual())
        .function("setUpright", select_overload<void(cv::KAZE&,bool)>(&Wrappers::KAZE_setUpright_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::KAZE>>("Ptr<KAZE>")
;

    emscripten::class_<cv::MSER ,base<Feature2D>>("MSER")
        .constructor(select_overload<Ptr<cv::MSER>(int,int,int,double,double,int,double,double,int)>(&Wrappers::MSER_create_wrapper))
        .constructor(select_overload<Ptr<cv::MSER>(int,int,int,double,double,int,double,double)>(&Wrappers::MSER_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::MSER>(int,int,int,double,double,int,double)>(&Wrappers::MSER_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::MSER>(int,int,int,double,double,int)>(&Wrappers::MSER_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::MSER>(int,int,int,double,double)>(&Wrappers::MSER_create_wrapper_4))
        .constructor(select_overload<Ptr<cv::MSER>(int,int,int,double)>(&Wrappers::MSER_create_wrapper_5))
        .constructor(select_overload<Ptr<cv::MSER>(int,int,int)>(&Wrappers::MSER_create_wrapper_6))
        .constructor(select_overload<Ptr<cv::MSER>(int,int)>(&Wrappers::MSER_create_wrapper_7))
        .constructor(select_overload<Ptr<cv::MSER>(int)>(&Wrappers::MSER_create_wrapper_8))
        .constructor(select_overload<Ptr<cv::MSER>()>(&Wrappers::MSER_create_wrapper_9))
        .function("detectRegions", select_overload<void(cv::MSER&,const cv::Mat&,std::vector<std::vector<Point>>&,std::vector<Rect>&)>(&Wrappers::MSER_detectRegions_wrapper), pure_virtual())
        .function("getDefaultName", select_overload<String(cv::MSER&)>(&Wrappers::MSER_getDefaultName_wrapper))
        .function("getDelta", select_overload<int()const>(&cv::MSER::getDelta), pure_virtual())
        .function("getMaxArea", select_overload<int()const>(&cv::MSER::getMaxArea), pure_virtual())
        .function("getMinArea", select_overload<int()const>(&cv::MSER::getMinArea), pure_virtual())
        .function("getPass2Only", select_overload<bool()const>(&cv::MSER::getPass2Only), pure_virtual())
        .function("setDelta", select_overload<void(cv::MSER&,int)>(&Wrappers::MSER_setDelta_wrapper), pure_virtual())
        .function("setMaxArea", select_overload<void(cv::MSER&,int)>(&Wrappers::MSER_setMaxArea_wrapper), pure_virtual())
        .function("setMinArea", select_overload<void(cv::MSER&,int)>(&Wrappers::MSER_setMinArea_wrapper), pure_virtual())
        .function("setPass2Only", select_overload<void(cv::MSER&,bool)>(&Wrappers::MSER_setPass2Only_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::MSER>>("Ptr<MSER>")
;

    emscripten::class_<cv::MergeDebevec ,base<MergeExposures>>("MergeDebevec")
        .constructor(select_overload<Ptr<cv::MergeDebevec>()>(&cv::createMergeDebevec))
        .function("process", select_overload<void(cv::MergeDebevec&,const std::vector<cv::Mat>&,cv::Mat&,const cv::Mat&,const cv::Mat&)>(&Wrappers::MergeDebevec_process_wrapper), pure_virtual())
        .function("process1", select_overload<void(cv::MergeDebevec&,const std::vector<cv::Mat>&,cv::Mat&,const cv::Mat&)>(&Wrappers::MergeDebevec_process_wrapper1), pure_virtual())
        .smart_ptr<Ptr<cv::MergeDebevec>>("Ptr<MergeDebevec>")
;

    emscripten::class_<cv::MergeExposures ,base<Algorithm>>("MergeExposures")
        .function("process", select_overload<void(cv::MergeExposures&,const std::vector<cv::Mat>&,cv::Mat&,const cv::Mat&,const cv::Mat&)>(&Wrappers::MergeExposures_process_wrapper), pure_virtual());

    emscripten::class_<cv::MergeMertens ,base<MergeExposures>>("MergeMertens")
        .constructor(select_overload<Ptr<cv::MergeMertens>(float,float,float)>(&Wrappers::_createMergeMertens_wrapper))
        .constructor(select_overload<Ptr<cv::MergeMertens>(float,float)>(&Wrappers::_createMergeMertens_wrapper_1))
        .constructor(select_overload<Ptr<cv::MergeMertens>(float)>(&Wrappers::_createMergeMertens_wrapper_2))
        .constructor(select_overload<Ptr<cv::MergeMertens>()>(&Wrappers::_createMergeMertens_wrapper_3))
        .function("getContrastWeight", select_overload<float()const>(&cv::MergeMertens::getContrastWeight), pure_virtual())
        .function("getExposureWeight", select_overload<float()const>(&cv::MergeMertens::getExposureWeight), pure_virtual())
        .function("getSaturationWeight", select_overload<float()const>(&cv::MergeMertens::getSaturationWeight), pure_virtual())
        .function("process", select_overload<void(cv::MergeMertens&,const std::vector<cv::Mat>&,cv::Mat&,const cv::Mat&,const cv::Mat&)>(&Wrappers::MergeMertens_process_wrapper), pure_virtual())
        .function("process1", select_overload<void(cv::MergeMertens&,const std::vector<cv::Mat>&,cv::Mat&)>(&Wrappers::MergeMertens_process_wrapper1), pure_virtual())
        .function("setContrastWeight", select_overload<void(cv::MergeMertens&,float)>(&Wrappers::MergeMertens_setContrastWeight_wrapper), pure_virtual())
        .function("setExposureWeight", select_overload<void(cv::MergeMertens&,float)>(&Wrappers::MergeMertens_setExposureWeight_wrapper), pure_virtual())
        .function("setSaturationWeight", select_overload<void(cv::MergeMertens&,float)>(&Wrappers::MergeMertens_setSaturationWeight_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::MergeMertens>>("Ptr<MergeMertens>")
;

    emscripten::class_<cv::MergeRobertson ,base<MergeExposures>>("MergeRobertson")
        .constructor(select_overload<Ptr<cv::MergeRobertson>()>(&cv::createMergeRobertson))
        .function("process", select_overload<void(cv::MergeRobertson&,const std::vector<cv::Mat>&,cv::Mat&,const cv::Mat&,const cv::Mat&)>(&Wrappers::MergeRobertson_process_wrapper), pure_virtual())
        .function("process1", select_overload<void(cv::MergeRobertson&,const std::vector<cv::Mat>&,cv::Mat&,const cv::Mat&)>(&Wrappers::MergeRobertson_process_wrapper1), pure_virtual())
        .smart_ptr<Ptr<cv::MergeRobertson>>("Ptr<MergeRobertson>")
;

    emscripten::class_<cv::ORB ,base<Feature2D>>("ORB")
        .constructor(select_overload<Ptr<cv::ORB>(int,float,int,int,int,int,cv::ORB::ScoreType,int,int)>(&Wrappers::ORB_create_wrapper))
        .constructor(select_overload<Ptr<cv::ORB>(int,float,int,int,int,int,cv::ORB::ScoreType,int)>(&Wrappers::ORB_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::ORB>(int,float,int,int,int,int,cv::ORB::ScoreType)>(&Wrappers::ORB_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::ORB>(int,float,int,int,int,int)>(&Wrappers::ORB_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::ORB>(int,float,int,int,int)>(&Wrappers::ORB_create_wrapper_4))
        .constructor(select_overload<Ptr<cv::ORB>(int,float,int,int)>(&Wrappers::ORB_create_wrapper_5))
        .constructor(select_overload<Ptr<cv::ORB>(int,float,int)>(&Wrappers::ORB_create_wrapper_6))
        .constructor(select_overload<Ptr<cv::ORB>(int,float)>(&Wrappers::ORB_create_wrapper_7))
        .constructor(select_overload<Ptr<cv::ORB>(int)>(&Wrappers::ORB_create_wrapper_8))
        .constructor(select_overload<Ptr<cv::ORB>()>(&Wrappers::ORB_create_wrapper_9))
        .function("getDefaultName", select_overload<String(cv::ORB&)>(&Wrappers::ORB_getDefaultName_wrapper))
        .function("getFastThreshold", select_overload<int()const>(&cv::ORB::getFastThreshold), pure_virtual())
        .function("setEdgeThreshold", select_overload<void(cv::ORB&,int)>(&Wrappers::ORB_setEdgeThreshold_wrapper), pure_virtual())
        .function("setFastThreshold", select_overload<void(cv::ORB&,int)>(&Wrappers::ORB_setFastThreshold_wrapper), pure_virtual())
        .function("setFirstLevel", select_overload<void(cv::ORB&,int)>(&Wrappers::ORB_setFirstLevel_wrapper), pure_virtual())
        .function("setMaxFeatures", select_overload<void(cv::ORB&,int)>(&Wrappers::ORB_setMaxFeatures_wrapper), pure_virtual())
        .function("setNLevels", select_overload<void(cv::ORB&,int)>(&Wrappers::ORB_setNLevels_wrapper), pure_virtual())
        .function("setPatchSize", select_overload<void(cv::ORB&,int)>(&Wrappers::ORB_setPatchSize_wrapper), pure_virtual())
        .function("setScaleFactor", select_overload<void(cv::ORB&,double)>(&Wrappers::ORB_setScaleFactor_wrapper), pure_virtual())
        .function("setScoreType", select_overload<void(cv::ORB&,cv::ORB::ScoreType)>(&Wrappers::ORB_setScoreType_wrapper), pure_virtual())
        .function("setWTA_K", select_overload<void(cv::ORB&,int)>(&Wrappers::ORB_setWTA_K_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::ORB>>("Ptr<ORB>")
;

    emscripten::class_<cv::QRCodeDetector ,base<GraphicalCodeDetector>>("QRCodeDetector")
        .constructor<>()
        .function("decodeCurved", select_overload<String(cv::QRCodeDetector&,const cv::Mat&,const cv::Mat&,cv::Mat&)>(&Wrappers::QRCodeDetector_decodeCurved_wrapper))
        .function("decodeCurved", select_overload<String(cv::QRCodeDetector&,const cv::Mat&,const cv::Mat&)>(&Wrappers::QRCodeDetector_decodeCurved_wrapper_1))
        .function("detectAndDecodeCurved", select_overload<string(cv::QRCodeDetector&,const cv::Mat&,cv::Mat&,cv::Mat&)>(&Wrappers::QRCodeDetector_detectAndDecodeCurved_wrapper))
        .function("detectAndDecodeCurved", select_overload<string(cv::QRCodeDetector&,const cv::Mat&,cv::Mat&)>(&Wrappers::QRCodeDetector_detectAndDecodeCurved_wrapper_1))
        .function("detectAndDecodeCurved", select_overload<string(cv::QRCodeDetector&,const cv::Mat&)>(&Wrappers::QRCodeDetector_detectAndDecodeCurved_wrapper_2))
        .function("setEpsX", select_overload<QRCodeDetector(cv::QRCodeDetector&,double)>(&Wrappers::QRCodeDetector_setEpsX_wrapper))
        .function("setEpsY", select_overload<QRCodeDetector(cv::QRCodeDetector&,double)>(&Wrappers::QRCodeDetector_setEpsY_wrapper));

    emscripten::class_<cv::QRCodeDetectorAruco ,base<GraphicalCodeDetector>>("QRCodeDetectorAruco")
        .constructor<>()
        .constructor<const QRCodeDetectorAruco_Params&>()
        .function("setArucoParameters", select_overload<void(cv::QRCodeDetectorAruco&,const aruco_DetectorParameters&)>(&Wrappers::QRCodeDetectorAruco_setArucoParameters_wrapper))
        .function("setDetectorParameters", select_overload<QRCodeDetectorAruco(cv::QRCodeDetectorAruco&,const QRCodeDetectorAruco_Params&)>(&Wrappers::QRCodeDetectorAruco_setDetectorParameters_wrapper));

    emscripten::class_<cv::QRCodeDetectorAruco::Params >("QRCodeDetectorAruco_Params")
        .constructor<>()
        .property("minModuleSizeInPyramid", &cv::QRCodeDetectorAruco::Params::minModuleSizeInPyramid)
        .property("maxRotation", &cv::QRCodeDetectorAruco::Params::maxRotation)
        .property("maxModuleSizeMismatch", &cv::QRCodeDetectorAruco::Params::maxModuleSizeMismatch)
        .property("maxTimingPatternMismatch", &cv::QRCodeDetectorAruco::Params::maxTimingPatternMismatch)
        .property("maxPenalties", &cv::QRCodeDetectorAruco::Params::maxPenalties)
        .property("maxColorsMismatch", &cv::QRCodeDetectorAruco::Params::maxColorsMismatch)
        .property("scaleTimingPatternScore", &cv::QRCodeDetectorAruco::Params::scaleTimingPatternScore);

    emscripten::class_<cv::SIFT ,base<Feature2D>>("SIFT")
        .constructor(select_overload<Ptr<cv::SIFT>(int,int,double,double,double,bool)>(&Wrappers::SIFT_create_wrapper))
        .constructor(select_overload<Ptr<cv::SIFT>(int,int,double,double,double)>(&Wrappers::SIFT_create_wrapper_1))
        .constructor(select_overload<Ptr<cv::SIFT>(int,int,double,double)>(&Wrappers::SIFT_create_wrapper_2))
        .constructor(select_overload<Ptr<cv::SIFT>(int,int,double)>(&Wrappers::SIFT_create_wrapper_3))
        .constructor(select_overload<Ptr<cv::SIFT>(int,int)>(&Wrappers::SIFT_create_wrapper_4))
        .constructor(select_overload<Ptr<cv::SIFT>(int)>(&Wrappers::SIFT_create_wrapper_5))
        .constructor(select_overload<Ptr<cv::SIFT>()>(&Wrappers::SIFT_create_wrapper_6))
        .constructor(select_overload<Ptr<cv::SIFT>(int,int,double,double,double,int,bool)>(&Wrappers::SIFT_create_wrapper1))
        .function("getContrastThreshold", select_overload<double()const>(&cv::SIFT::getContrastThreshold), pure_virtual())
        .function("getDefaultName", select_overload<String(cv::SIFT&)>(&Wrappers::SIFT_getDefaultName_wrapper))
        .function("getEdgeThreshold", select_overload<double()const>(&cv::SIFT::getEdgeThreshold), pure_virtual())
        .function("getNFeatures", select_overload<int()const>(&cv::SIFT::getNFeatures), pure_virtual())
        .function("getNOctaveLayers", select_overload<int()const>(&cv::SIFT::getNOctaveLayers), pure_virtual())
        .function("getSigma", select_overload<double()const>(&cv::SIFT::getSigma), pure_virtual())
        .function("setContrastThreshold", select_overload<void(cv::SIFT&,double)>(&Wrappers::SIFT_setContrastThreshold_wrapper), pure_virtual())
        .function("setEdgeThreshold", select_overload<void(cv::SIFT&,double)>(&Wrappers::SIFT_setEdgeThreshold_wrapper), pure_virtual())
        .function("setNFeatures", select_overload<void(cv::SIFT&,int)>(&Wrappers::SIFT_setNFeatures_wrapper), pure_virtual())
        .function("setNOctaveLayers", select_overload<void(cv::SIFT&,int)>(&Wrappers::SIFT_setNOctaveLayers_wrapper), pure_virtual())
        .function("setSigma", select_overload<void(cv::SIFT&,double)>(&Wrappers::SIFT_setSigma_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::SIFT>>("Ptr<SIFT>")
;

    emscripten::class_<cv::SimpleBlobDetector ,base<Feature2D>>("SimpleBlobDetector")
        .constructor(select_overload<Ptr<cv::SimpleBlobDetector>(const SimpleBlobDetector_Params&)>(&Wrappers::SimpleBlobDetector_create_wrapper))
        .constructor(select_overload<Ptr<cv::SimpleBlobDetector>()>(&Wrappers::SimpleBlobDetector_create_wrapper_1))
        .function("getDefaultName", select_overload<String(cv::SimpleBlobDetector&)>(&Wrappers::SimpleBlobDetector_getDefaultName_wrapper))
        .function("getParams", select_overload<SimpleBlobDetector_Params()const>(&cv::SimpleBlobDetector::getParams), pure_virtual())
        .function("setParams", select_overload<void(cv::SimpleBlobDetector&,const SimpleBlobDetector_Params&)>(&Wrappers::SimpleBlobDetector_setParams_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::SimpleBlobDetector>>("Ptr<SimpleBlobDetector>")
;

    emscripten::class_<cv::SimpleBlobDetector::Params >("SimpleBlobDetector_Params")
        .property("thresholdStep", &cv::SimpleBlobDetector::Params::thresholdStep)
        .property("minThreshold", &cv::SimpleBlobDetector::Params::minThreshold)
        .property("maxThreshold", &cv::SimpleBlobDetector::Params::maxThreshold)
        .property("minRepeatability", &cv::SimpleBlobDetector::Params::minRepeatability)
        .property("minDistBetweenBlobs", &cv::SimpleBlobDetector::Params::minDistBetweenBlobs)
        .property("filterByColor", &cv::SimpleBlobDetector::Params::filterByColor)
        .property("blobColor", &cv::SimpleBlobDetector::Params::blobColor)
        .property("filterByArea", &cv::SimpleBlobDetector::Params::filterByArea)
        .property("minArea", &cv::SimpleBlobDetector::Params::minArea)
        .property("maxArea", &cv::SimpleBlobDetector::Params::maxArea)
        .property("filterByCircularity", &cv::SimpleBlobDetector::Params::filterByCircularity)
        .property("minCircularity", &cv::SimpleBlobDetector::Params::minCircularity)
        .property("maxCircularity", &cv::SimpleBlobDetector::Params::maxCircularity)
        .property("filterByInertia", &cv::SimpleBlobDetector::Params::filterByInertia)
        .property("minInertiaRatio", &cv::SimpleBlobDetector::Params::minInertiaRatio)
        .property("maxInertiaRatio", &cv::SimpleBlobDetector::Params::maxInertiaRatio)
        .property("filterByConvexity", &cv::SimpleBlobDetector::Params::filterByConvexity)
        .property("minConvexity", &cv::SimpleBlobDetector::Params::minConvexity)
        .property("maxConvexity", &cv::SimpleBlobDetector::Params::maxConvexity)
        .property("collectContours", &cv::SimpleBlobDetector::Params::collectContours);

    emscripten::class_<cv::Tonemap ,base<Algorithm>>("Tonemap")
        .function("getGamma", select_overload<float()const>(&cv::Tonemap::getGamma), pure_virtual())
        .function("process", select_overload<void(cv::Tonemap&,const cv::Mat&,cv::Mat&)>(&Wrappers::Tonemap_process_wrapper), pure_virtual())
        .function("setGamma", select_overload<void(cv::Tonemap&,float)>(&Wrappers::Tonemap_setGamma_wrapper), pure_virtual());

    emscripten::class_<cv::TonemapDrago ,base<Tonemap>>("TonemapDrago")
        .constructor(select_overload<Ptr<cv::TonemapDrago>(float,float,float)>(&Wrappers::_createTonemapDrago_wrapper))
        .constructor(select_overload<Ptr<cv::TonemapDrago>(float,float)>(&Wrappers::_createTonemapDrago_wrapper_1))
        .constructor(select_overload<Ptr<cv::TonemapDrago>(float)>(&Wrappers::_createTonemapDrago_wrapper_2))
        .constructor(select_overload<Ptr<cv::TonemapDrago>()>(&Wrappers::_createTonemapDrago_wrapper_3))
        .function("getBias", select_overload<float()const>(&cv::TonemapDrago::getBias), pure_virtual())
        .function("getSaturation", select_overload<float()const>(&cv::TonemapDrago::getSaturation), pure_virtual())
        .function("setBias", select_overload<void(cv::TonemapDrago&,float)>(&Wrappers::TonemapDrago_setBias_wrapper), pure_virtual())
        .function("setSaturation", select_overload<void(cv::TonemapDrago&,float)>(&Wrappers::TonemapDrago_setSaturation_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::TonemapDrago>>("Ptr<TonemapDrago>")
;

    emscripten::class_<cv::TonemapMantiuk ,base<Tonemap>>("TonemapMantiuk")
        .constructor(select_overload<Ptr<cv::TonemapMantiuk>(float,float,float)>(&Wrappers::_createTonemapMantiuk_wrapper))
        .constructor(select_overload<Ptr<cv::TonemapMantiuk>(float,float)>(&Wrappers::_createTonemapMantiuk_wrapper_1))
        .constructor(select_overload<Ptr<cv::TonemapMantiuk>(float)>(&Wrappers::_createTonemapMantiuk_wrapper_2))
        .constructor(select_overload<Ptr<cv::TonemapMantiuk>()>(&Wrappers::_createTonemapMantiuk_wrapper_3))
        .function("getSaturation", select_overload<float()const>(&cv::TonemapMantiuk::getSaturation), pure_virtual())
        .function("getScale", select_overload<float()const>(&cv::TonemapMantiuk::getScale), pure_virtual())
        .function("setSaturation", select_overload<void(cv::TonemapMantiuk&,float)>(&Wrappers::TonemapMantiuk_setSaturation_wrapper), pure_virtual())
        .function("setScale", select_overload<void(cv::TonemapMantiuk&,float)>(&Wrappers::TonemapMantiuk_setScale_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::TonemapMantiuk>>("Ptr<TonemapMantiuk>")
;

    emscripten::class_<cv::TonemapReinhard ,base<Tonemap>>("TonemapReinhard")
        .constructor(select_overload<Ptr<cv::TonemapReinhard>(float,float,float,float)>(&Wrappers::_createTonemapReinhard_wrapper))
        .constructor(select_overload<Ptr<cv::TonemapReinhard>(float,float,float)>(&Wrappers::_createTonemapReinhard_wrapper_1))
        .constructor(select_overload<Ptr<cv::TonemapReinhard>(float,float)>(&Wrappers::_createTonemapReinhard_wrapper_2))
        .constructor(select_overload<Ptr<cv::TonemapReinhard>(float)>(&Wrappers::_createTonemapReinhard_wrapper_3))
        .constructor(select_overload<Ptr<cv::TonemapReinhard>()>(&Wrappers::_createTonemapReinhard_wrapper_4))
        .function("getColorAdaptation", select_overload<float()const>(&cv::TonemapReinhard::getColorAdaptation), pure_virtual())
        .function("getIntensity", select_overload<float()const>(&cv::TonemapReinhard::getIntensity), pure_virtual())
        .function("getLightAdaptation", select_overload<float()const>(&cv::TonemapReinhard::getLightAdaptation), pure_virtual())
        .function("setColorAdaptation", select_overload<void(cv::TonemapReinhard&,float)>(&Wrappers::TonemapReinhard_setColorAdaptation_wrapper), pure_virtual())
        .function("setIntensity", select_overload<void(cv::TonemapReinhard&,float)>(&Wrappers::TonemapReinhard_setIntensity_wrapper), pure_virtual())
        .function("setLightAdaptation", select_overload<void(cv::TonemapReinhard&,float)>(&Wrappers::TonemapReinhard_setLightAdaptation_wrapper), pure_virtual())
        .smart_ptr<Ptr<cv::TonemapReinhard>>("Ptr<TonemapReinhard>")
;

    emscripten::class_<cv::TrackerMIL ,base<Tracker>>("TrackerMIL")
        .constructor(select_overload<Ptr<cv::TrackerMIL>(const TrackerMIL_Params&)>(&Wrappers::TrackerMIL_create_wrapper))
        .constructor(select_overload<Ptr<cv::TrackerMIL>()>(&Wrappers::TrackerMIL_create_wrapper_1))
        .smart_ptr<Ptr<cv::TrackerMIL>>("Ptr<TrackerMIL>")
;

    emscripten::class_<cv::TrackerMIL::Params >("TrackerMIL_Params")
        .property("samplerInitInRadius", &cv::TrackerMIL::Params::samplerInitInRadius)
        .property("samplerInitMaxNegNum", &cv::TrackerMIL::Params::samplerInitMaxNegNum)
        .property("samplerSearchWinSize", &cv::TrackerMIL::Params::samplerSearchWinSize)
        .property("samplerTrackInRadius", &cv::TrackerMIL::Params::samplerTrackInRadius)
        .property("samplerTrackMaxPosNum", &cv::TrackerMIL::Params::samplerTrackMaxPosNum)
        .property("samplerTrackMaxNegNum", &cv::TrackerMIL::Params::samplerTrackMaxNegNum)
        .property("featureSetNumFeatures", &cv::TrackerMIL::Params::featureSetNumFeatures);

    emscripten::class_<cv::UsacParams >("UsacParams")
        .constructor<>()
        .property("confidence", &cv::UsacParams::confidence)
        .property("isParallel", &cv::UsacParams::isParallel)
        .property("loIterations", &cv::UsacParams::loIterations)
        .property("loMethod", binding_utils::underlying_ptr(&cv::UsacParams::loMethod))
        .property("loSampleSize", &cv::UsacParams::loSampleSize)
        .property("maxIterations", &cv::UsacParams::maxIterations)
        .property("neighborsSearch", binding_utils::underlying_ptr(&cv::UsacParams::neighborsSearch))
        .property("randomGeneratorState", &cv::UsacParams::randomGeneratorState)
        .property("sampler", binding_utils::underlying_ptr(&cv::UsacParams::sampler))
        .property("score", binding_utils::underlying_ptr(&cv::UsacParams::score))
        .property("threshold", &cv::UsacParams::threshold)
        .property("final_polisher", binding_utils::underlying_ptr(&cv::UsacParams::final_polisher))
        .property("final_polisher_iterations", &cv::UsacParams::final_polisher_iterations);

    emscripten::class_<cv::aruco::ArucoDetector ,base<Algorithm>>("aruco_ArucoDetector")
        .constructor<const Dictionary&, const DetectorParameters&, const RefineParameters&>()
        .function("detectMarkers", select_overload<void(cv::aruco::ArucoDetector&,const cv::Mat&,std::vector<cv::Mat>&,cv::Mat&,std::vector<cv::Mat>&)>(&Wrappers::aruco_ArucoDetector_detectMarkers_wrapper))
        .function("detectMarkers", select_overload<void(cv::aruco::ArucoDetector&,const cv::Mat&,std::vector<cv::Mat>&,cv::Mat&)>(&Wrappers::aruco_ArucoDetector_detectMarkers_wrapper_1))
        .function("refineDetectedMarkers", select_overload<void(cv::aruco::ArucoDetector&,const cv::Mat&,const Board&,std::vector<cv::Mat>&,cv::Mat&,std::vector<cv::Mat>&,const cv::Mat&,const cv::Mat&,cv::Mat&)>(&Wrappers::aruco_ArucoDetector_refineDetectedMarkers_wrapper))
        .function("refineDetectedMarkers", select_overload<void(cv::aruco::ArucoDetector&,const cv::Mat&,const Board&,std::vector<cv::Mat>&,cv::Mat&,std::vector<cv::Mat>&,const cv::Mat&,const cv::Mat&)>(&Wrappers::aruco_ArucoDetector_refineDetectedMarkers_wrapper_1))
        .function("refineDetectedMarkers", select_overload<void(cv::aruco::ArucoDetector&,const cv::Mat&,const Board&,std::vector<cv::Mat>&,cv::Mat&,std::vector<cv::Mat>&,const cv::Mat&)>(&Wrappers::aruco_ArucoDetector_refineDetectedMarkers_wrapper_2))
        .function("refineDetectedMarkers", select_overload<void(cv::aruco::ArucoDetector&,const cv::Mat&,const Board&,std::vector<cv::Mat>&,cv::Mat&,std::vector<cv::Mat>&)>(&Wrappers::aruco_ArucoDetector_refineDetectedMarkers_wrapper_3))
        .function("setDetectorParameters", select_overload<void(cv::aruco::ArucoDetector&,const DetectorParameters&)>(&Wrappers::aruco_ArucoDetector_setDetectorParameters_wrapper))
        .function("setDictionary", select_overload<void(cv::aruco::ArucoDetector&,const Dictionary&)>(&Wrappers::aruco_ArucoDetector_setDictionary_wrapper))
        .function("setRefineParameters", select_overload<void(cv::aruco::ArucoDetector&,const RefineParameters&)>(&Wrappers::aruco_ArucoDetector_setRefineParameters_wrapper));

    emscripten::class_<cv::aruco::Board >("aruco_Board")
        .constructor<const std::vector<cv::Mat>&, const Dictionary&, const cv::Mat&>()
        .function("generateImage", select_overload<void(cv::aruco::Board&,Size,cv::Mat&,int,int)>(&Wrappers::aruco_Board_generateImage_wrapper))
        .function("generateImage", select_overload<void(cv::aruco::Board&,Size,cv::Mat&,int)>(&Wrappers::aruco_Board_generateImage_wrapper_1))
        .function("generateImage", select_overload<void(cv::aruco::Board&,Size,cv::Mat&)>(&Wrappers::aruco_Board_generateImage_wrapper_2))
        .function("matchImagePoints", select_overload<void(cv::aruco::Board&,const std::vector<cv::Mat>&,const cv::Mat&,cv::Mat&,cv::Mat&)>(&Wrappers::aruco_Board_matchImagePoints_wrapper));

    emscripten::class_<cv::aruco::CharucoBoard ,base<aruco::Board>>("aruco_CharucoBoard")
        .constructor<const Size&, float, float, const Dictionary&, const cv::Mat&>()
        .function("checkCharucoCornersCollinear", select_overload<bool(cv::aruco::CharucoBoard&,const cv::Mat&)>(&Wrappers::aruco_CharucoBoard_checkCharucoCornersCollinear_wrapper))
        .function("getChessboardCorners", select_overload<std::vector<Point3f>()const>(&cv::aruco::CharucoBoard::getChessboardCorners))
        .function("getLegacyPattern", select_overload<bool()const>(&cv::aruco::CharucoBoard::getLegacyPattern))
        .function("setLegacyPattern", select_overload<void(cv::aruco::CharucoBoard&,bool)>(&Wrappers::aruco_CharucoBoard_setLegacyPattern_wrapper));

    emscripten::class_<cv::aruco::CharucoDetector ,base<Algorithm>>("aruco_CharucoDetector")
        .constructor<const CharucoBoard&, const CharucoParameters&, const DetectorParameters&, const RefineParameters&>()
        .function("detectBoard", select_overload<void(cv::aruco::CharucoDetector&,const cv::Mat&,cv::Mat&,cv::Mat&,std::vector<cv::Mat>&,cv::Mat&)>(&Wrappers::aruco_CharucoDetector_detectBoard_wrapper))
        .function("detectBoard", select_overload<void(cv::aruco::CharucoDetector&,const cv::Mat&,cv::Mat&,cv::Mat&,std::vector<cv::Mat>&)>(&Wrappers::aruco_CharucoDetector_detectBoard_wrapper_1))
        .function("detectBoard", select_overload<void(cv::aruco::CharucoDetector&,const cv::Mat&,cv::Mat&,cv::Mat&)>(&Wrappers::aruco_CharucoDetector_detectBoard_wrapper_2))
        .function("detectDiamonds", select_overload<void(cv::aruco::CharucoDetector&,const cv::Mat&,std::vector<cv::Mat>&,cv::Mat&,std::vector<cv::Mat>&,cv::Mat&)>(&Wrappers::aruco_CharucoDetector_detectDiamonds_wrapper))
        .function("detectDiamonds", select_overload<void(cv::aruco::CharucoDetector&,const cv::Mat&,std::vector<cv::Mat>&,cv::Mat&,std::vector<cv::Mat>&)>(&Wrappers::aruco_CharucoDetector_detectDiamonds_wrapper_1))
        .function("detectDiamonds", select_overload<void(cv::aruco::CharucoDetector&,const cv::Mat&,std::vector<cv::Mat>&,cv::Mat&)>(&Wrappers::aruco_CharucoDetector_detectDiamonds_wrapper_2))
        .function("setBoard", select_overload<void(cv::aruco::CharucoDetector&,const CharucoBoard&)>(&Wrappers::aruco_CharucoDetector_setBoard_wrapper))
        .function("setCharucoParameters", select_overload<void(cv::aruco::CharucoDetector&,CharucoParameters&)>(&Wrappers::aruco_CharucoDetector_setCharucoParameters_wrapper))
        .function("setDetectorParameters", select_overload<void(cv::aruco::CharucoDetector&,const DetectorParameters&)>(&Wrappers::aruco_CharucoDetector_setDetectorParameters_wrapper))
        .function("setRefineParameters", select_overload<void(cv::aruco::CharucoDetector&,const RefineParameters&)>(&Wrappers::aruco_CharucoDetector_setRefineParameters_wrapper));

    emscripten::class_<cv::aruco::CharucoParameters >("aruco_CharucoParameters")
        .constructor<>()
        .property("cameraMatrix", &cv::aruco::CharucoParameters::cameraMatrix)
        .property("distCoeffs", &cv::aruco::CharucoParameters::distCoeffs)
        .property("minMarkers", &cv::aruco::CharucoParameters::minMarkers)
        .property("tryRefineMarkers", &cv::aruco::CharucoParameters::tryRefineMarkers)
        .property("checkMarkers", &cv::aruco::CharucoParameters::checkMarkers);

    emscripten::class_<cv::aruco::DetectorParameters >("aruco_DetectorParameters")
        .constructor<>()
        .property("adaptiveThreshWinSizeMin", &cv::aruco::DetectorParameters::adaptiveThreshWinSizeMin)
        .property("adaptiveThreshWinSizeMax", &cv::aruco::DetectorParameters::adaptiveThreshWinSizeMax)
        .property("adaptiveThreshWinSizeStep", &cv::aruco::DetectorParameters::adaptiveThreshWinSizeStep)
        .property("adaptiveThreshConstant", &cv::aruco::DetectorParameters::adaptiveThreshConstant)
        .property("minMarkerPerimeterRate", &cv::aruco::DetectorParameters::minMarkerPerimeterRate)
        .property("maxMarkerPerimeterRate", &cv::aruco::DetectorParameters::maxMarkerPerimeterRate)
        .property("polygonalApproxAccuracyRate", &cv::aruco::DetectorParameters::polygonalApproxAccuracyRate)
        .property("minCornerDistanceRate", &cv::aruco::DetectorParameters::minCornerDistanceRate)
        .property("minDistanceToBorder", &cv::aruco::DetectorParameters::minDistanceToBorder)
        .property("minMarkerDistanceRate", &cv::aruco::DetectorParameters::minMarkerDistanceRate)
        .property("minGroupDistance", &cv::aruco::DetectorParameters::minGroupDistance)
        .property("cornerRefinementMethod", &cv::aruco::DetectorParameters::cornerRefinementMethod)
        .property("cornerRefinementWinSize", &cv::aruco::DetectorParameters::cornerRefinementWinSize)
        .property("relativeCornerRefinmentWinSize", &cv::aruco::DetectorParameters::relativeCornerRefinmentWinSize)
        .property("cornerRefinementMaxIterations", &cv::aruco::DetectorParameters::cornerRefinementMaxIterations)
        .property("cornerRefinementMinAccuracy", &cv::aruco::DetectorParameters::cornerRefinementMinAccuracy)
        .property("markerBorderBits", &cv::aruco::DetectorParameters::markerBorderBits)
        .property("perspectiveRemovePixelPerCell", &cv::aruco::DetectorParameters::perspectiveRemovePixelPerCell)
        .property("perspectiveRemoveIgnoredMarginPerCell", &cv::aruco::DetectorParameters::perspectiveRemoveIgnoredMarginPerCell)
        .property("maxErroneousBitsInBorderRate", &cv::aruco::DetectorParameters::maxErroneousBitsInBorderRate)
        .property("minOtsuStdDev", &cv::aruco::DetectorParameters::minOtsuStdDev)
        .property("errorCorrectionRate", &cv::aruco::DetectorParameters::errorCorrectionRate)
        .property("aprilTagQuadDecimate", &cv::aruco::DetectorParameters::aprilTagQuadDecimate)
        .property("aprilTagQuadSigma", &cv::aruco::DetectorParameters::aprilTagQuadSigma)
        .property("aprilTagMinClusterPixels", &cv::aruco::DetectorParameters::aprilTagMinClusterPixels)
        .property("aprilTagMaxNmaxima", &cv::aruco::DetectorParameters::aprilTagMaxNmaxima)
        .property("aprilTagCriticalRad", &cv::aruco::DetectorParameters::aprilTagCriticalRad)
        .property("aprilTagMaxLineFitMse", &cv::aruco::DetectorParameters::aprilTagMaxLineFitMse)
        .property("aprilTagMinWhiteBlackDiff", &cv::aruco::DetectorParameters::aprilTagMinWhiteBlackDiff)
        .property("aprilTagDeglitch", &cv::aruco::DetectorParameters::aprilTagDeglitch)
        .property("detectInvertedMarker", &cv::aruco::DetectorParameters::detectInvertedMarker)
        .property("useAruco3Detection", &cv::aruco::DetectorParameters::useAruco3Detection)
        .property("minSideLengthCanonicalImg", &cv::aruco::DetectorParameters::minSideLengthCanonicalImg)
        .property("minMarkerLengthRatioOriginalImg", &cv::aruco::DetectorParameters::minMarkerLengthRatioOriginalImg)
        .property("validBitIdThreshold", &cv::aruco::DetectorParameters::validBitIdThreshold);

    emscripten::class_<cv::aruco::Dictionary >("aruco_Dictionary")
        .constructor<>()
        .constructor<const cv::Mat&&, int, int>()
        .function("generateImageMarker", select_overload<void(cv::aruco::Dictionary&,int,int,cv::Mat&,int)>(&Wrappers::aruco_Dictionary_generateImageMarker_wrapper))
        .function("generateImageMarker", select_overload<void(cv::aruco::Dictionary&,int,int,cv::Mat&)>(&Wrappers::aruco_Dictionary_generateImageMarker_wrapper_1))
        .class_function("getBitsFromByteList", select_overload<Mat(cv::aruco::Dictionary&,const cv::Mat&&,int,int)>(&Wrappers::aruco_Dictionary_getBitsFromByteList_wrapper))
        .class_function("getBitsFromByteList", select_overload<Mat(cv::aruco::Dictionary&,const cv::Mat&&,int)>(&Wrappers::aruco_Dictionary_getBitsFromByteList_wrapper_1))
        .class_function("getByteListFromBits", select_overload<Mat(cv::aruco::Dictionary&,const cv::Mat&&)>(&Wrappers::aruco_Dictionary_getByteListFromBits_wrapper))
        .function("getDistanceToId", select_overload<int(cv::aruco::Dictionary&,const cv::Mat&,int,bool)>(&Wrappers::aruco_Dictionary_getDistanceToId_wrapper))
        .function("getDistanceToId", select_overload<int(cv::aruco::Dictionary&,const cv::Mat&,int)>(&Wrappers::aruco_Dictionary_getDistanceToId_wrapper_1))
        .property("bytesList", &cv::aruco::Dictionary::bytesList)
        .property("markerSize", &cv::aruco::Dictionary::markerSize)
        .property("maxCorrectionBits", &cv::aruco::Dictionary::maxCorrectionBits);

    emscripten::class_<cv::aruco::GridBoard ,base<aruco::Board>>("aruco_GridBoard")
        .constructor<const Size&, float, float, const Dictionary&, const cv::Mat&>()
        .function("getGridSize", select_overload<Size()const>(&cv::aruco::GridBoard::getGridSize))
        .function("getMarkerLength", select_overload<float()const>(&cv::aruco::GridBoard::getMarkerLength))
        .function("getMarkerSeparation", select_overload<float()const>(&cv::aruco::GridBoard::getMarkerSeparation));

    emscripten::class_<cv::aruco::RefineParameters >("aruco_RefineParameters")
        .constructor<float, float, bool>()
        .property("minRepDistance", &cv::aruco::RefineParameters::minRepDistance)
        .property("errorCorrectionRate", &cv::aruco::RefineParameters::errorCorrectionRate)
        .property("checkAllOrders", &cv::aruco::RefineParameters::checkAllOrders);

    emscripten::class_<cv::barcode::BarcodeDetector ,base<GraphicalCodeDetector>>("barcode_BarcodeDetector")
        .constructor<>()
        .constructor<const string&, const string&>()
        .function("decodeWithType", select_overload<bool(cv::barcode::BarcodeDetector&,const cv::Mat&,const cv::Mat&,std::vector<string>&,std::vector<string>&)>(&Wrappers::barcode_BarcodeDetector_decodeWithType_wrapper))
        .function("detectAndDecodeWithType", select_overload<bool(cv::barcode::BarcodeDetector&,const cv::Mat&,std::vector<string>&,std::vector<string>&,cv::Mat&)>(&Wrappers::barcode_BarcodeDetector_detectAndDecodeWithType_wrapper))
        .function("detectAndDecodeWithType", select_overload<bool(cv::barcode::BarcodeDetector&,const cv::Mat&,std::vector<string>&,std::vector<string>&)>(&Wrappers::barcode_BarcodeDetector_detectAndDecodeWithType_wrapper_1));

    emscripten::class_<cv::dnn::Net >("dnn_Net")
        .function("forward", select_overload<Mat(cv::dnn::Net&,const std::string&)>(&Wrappers::dnn_Net_forward_wrapper))
        .function("forward", select_overload<Mat(cv::dnn::Net&)>(&Wrappers::dnn_Net_forward_wrapper_1))
        .function("forward1", select_overload<void(cv::dnn::Net&,std::vector<cv::Mat>&,const std::string&)>(&Wrappers::dnn_Net_forward_wrapper1))
        .function("forward1", select_overload<void(cv::dnn::Net&,std::vector<cv::Mat>&)>(&Wrappers::dnn_Net_forward_wrapper1_1))
        .function("forward2", select_overload<void(cv::dnn::Net&,std::vector<cv::Mat>&,const emscripten::val&)>(&Wrappers::dnn_Net_forward_wrapper2))
        .function("getUnconnectedOutLayersNames", select_overload<std::vector<String>(cv::dnn::Net&)>(&Wrappers::dnn_Net_getUnconnectedOutLayersNames_wrapper))
        .function("setInput", select_overload<void(cv::dnn::Net&,const cv::Mat&,const std::string&,double,const Scalar&)>(&Wrappers::dnn_Net_setInput_wrapper))
        .function("setInput", select_overload<void(cv::dnn::Net&,const cv::Mat&,const std::string&,double)>(&Wrappers::dnn_Net_setInput_wrapper_1))
        .function("setInput", select_overload<void(cv::dnn::Net&,const cv::Mat&,const std::string&)>(&Wrappers::dnn_Net_setInput_wrapper_2))
        .function("setInput", select_overload<void(cv::dnn::Net&,const cv::Mat&)>(&Wrappers::dnn_Net_setInput_wrapper_3))
        .function("setPreferableBackend", select_overload<void(cv::dnn::Net&,int)>(&Wrappers::dnn_Net_setPreferableBackend_wrapper));

    emscripten::class_<cv::segmentation::IntelligentScissorsMB >("segmentation_IntelligentScissorsMB")
        .constructor<>()
        .function("applyImage", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,const cv::Mat&)>(&Wrappers::segmentation_IntelligentScissorsMB_applyImage_wrapper))
        .function("applyImageFeatures", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,const cv::Mat&,const cv::Mat&,const cv::Mat&,const cv::Mat&)>(&Wrappers::segmentation_IntelligentScissorsMB_applyImageFeatures_wrapper))
        .function("applyImageFeatures", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,const cv::Mat&,const cv::Mat&,const cv::Mat&)>(&Wrappers::segmentation_IntelligentScissorsMB_applyImageFeatures_wrapper_1))
        .function("buildMap", select_overload<void(cv::segmentation::IntelligentScissorsMB&,const Point&)>(&Wrappers::segmentation_IntelligentScissorsMB_buildMap_wrapper))
        .function("getContour", select_overload<void(cv::segmentation::IntelligentScissorsMB&,const Point&,cv::Mat&,bool)>(&Wrappers::segmentation_IntelligentScissorsMB_getContour_wrapper))
        .function("getContour", select_overload<void(cv::segmentation::IntelligentScissorsMB&,const Point&,cv::Mat&)>(&Wrappers::segmentation_IntelligentScissorsMB_getContour_wrapper_1))
        .function("setEdgeFeatureCannyParameters", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,double,double,int,bool)>(&Wrappers::segmentation_IntelligentScissorsMB_setEdgeFeatureCannyParameters_wrapper))
        .function("setEdgeFeatureCannyParameters", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,double,double,int)>(&Wrappers::segmentation_IntelligentScissorsMB_setEdgeFeatureCannyParameters_wrapper_1))
        .function("setEdgeFeatureCannyParameters", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,double,double)>(&Wrappers::segmentation_IntelligentScissorsMB_setEdgeFeatureCannyParameters_wrapper_2))
        .function("setEdgeFeatureZeroCrossingParameters", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,float)>(&Wrappers::segmentation_IntelligentScissorsMB_setEdgeFeatureZeroCrossingParameters_wrapper))
        .function("setEdgeFeatureZeroCrossingParameters", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&)>(&Wrappers::segmentation_IntelligentScissorsMB_setEdgeFeatureZeroCrossingParameters_wrapper_1))
        .function("setGradientMagnitudeMaxLimit", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,float)>(&Wrappers::segmentation_IntelligentScissorsMB_setGradientMagnitudeMaxLimit_wrapper))
        .function("setGradientMagnitudeMaxLimit", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&)>(&Wrappers::segmentation_IntelligentScissorsMB_setGradientMagnitudeMaxLimit_wrapper_1))
        .function("setWeights", select_overload<IntelligentScissorsMB(cv::segmentation::IntelligentScissorsMB&,float,float,float)>(&Wrappers::segmentation_IntelligentScissorsMB_setWeights_wrapper));

    emscripten::enum_<AKAZE::DescriptorType>("AKAZE_DescriptorType")
        .value("DESCRIPTOR_KAZE_UPRIGHT", AKAZE::DescriptorType::DESCRIPTOR_KAZE_UPRIGHT)
        .value("DESCRIPTOR_KAZE", AKAZE::DescriptorType::DESCRIPTOR_KAZE)
        .value("DESCRIPTOR_MLDB_UPRIGHT", AKAZE::DescriptorType::DESCRIPTOR_MLDB_UPRIGHT)
        .value("DESCRIPTOR_MLDB", AKAZE::DescriptorType::DESCRIPTOR_MLDB);

    emscripten::enum_<AccessFlag>("AccessFlag")
        .value("ACCESS_READ", AccessFlag::ACCESS_READ)
        .value("ACCESS_WRITE", AccessFlag::ACCESS_WRITE)
        .value("ACCESS_RW", AccessFlag::ACCESS_RW)
        .value("ACCESS_MASK", AccessFlag::ACCESS_MASK)
        .value("ACCESS_FAST", AccessFlag::ACCESS_FAST);

    emscripten::enum_<AdaptiveThresholdTypes>("AdaptiveThresholdTypes")
        .value("ADAPTIVE_THRESH_MEAN_C", AdaptiveThresholdTypes::ADAPTIVE_THRESH_MEAN_C)
        .value("ADAPTIVE_THRESH_GAUSSIAN_C", AdaptiveThresholdTypes::ADAPTIVE_THRESH_GAUSSIAN_C);

    emscripten::enum_<AgastFeatureDetector::DetectorType>("AgastFeatureDetector_DetectorType")
        .value("AGAST_5_8", AgastFeatureDetector::DetectorType::AGAST_5_8)
        .value("AGAST_7_12d", AgastFeatureDetector::DetectorType::AGAST_7_12d)
        .value("AGAST_7_12s", AgastFeatureDetector::DetectorType::AGAST_7_12s)
        .value("OAST_9_16", AgastFeatureDetector::DetectorType::OAST_9_16);

    emscripten::enum_<AlgorithmHint>("AlgorithmHint")
        .value("ALGO_HINT_DEFAULT", AlgorithmHint::ALGO_HINT_DEFAULT)
        .value("ALGO_HINT_ACCURATE", AlgorithmHint::ALGO_HINT_ACCURATE)
        .value("ALGO_HINT_APPROX", AlgorithmHint::ALGO_HINT_APPROX);

    emscripten::enum_<BorderTypes>("BorderTypes")
        .value("BORDER_CONSTANT", BorderTypes::BORDER_CONSTANT)
        .value("BORDER_REPLICATE", BorderTypes::BORDER_REPLICATE)
        .value("BORDER_REFLECT", BorderTypes::BORDER_REFLECT)
        .value("BORDER_WRAP", BorderTypes::BORDER_WRAP)
        .value("BORDER_REFLECT_101", BorderTypes::BORDER_REFLECT_101)
        .value("BORDER_TRANSPARENT", BorderTypes::BORDER_TRANSPARENT)
        .value("BORDER_REFLECT101", BorderTypes::BORDER_REFLECT101)
        .value("BORDER_DEFAULT", BorderTypes::BORDER_DEFAULT)
        .value("BORDER_ISOLATED", BorderTypes::BORDER_ISOLATED);

    emscripten::enum_<CirclesGridFinderParameters::GridType>("CirclesGridFinderParameters_GridType")
        .value("SYMMETRIC_GRID", CirclesGridFinderParameters::GridType::SYMMETRIC_GRID)
        .value("ASYMMETRIC_GRID", CirclesGridFinderParameters::GridType::ASYMMETRIC_GRID);

    emscripten::enum_<CmpTypes>("CmpTypes")
        .value("CMP_EQ", CmpTypes::CMP_EQ)
        .value("CMP_GT", CmpTypes::CMP_GT)
        .value("CMP_GE", CmpTypes::CMP_GE)
        .value("CMP_LT", CmpTypes::CMP_LT)
        .value("CMP_LE", CmpTypes::CMP_LE)
        .value("CMP_NE", CmpTypes::CMP_NE);

    emscripten::enum_<ColorConversionCodes>("ColorConversionCodes")
        .value("COLOR_BGR2BGRA", ColorConversionCodes::COLOR_BGR2BGRA)
        .value("COLOR_RGB2RGBA", ColorConversionCodes::COLOR_RGB2RGBA)
        .value("COLOR_BGRA2BGR", ColorConversionCodes::COLOR_BGRA2BGR)
        .value("COLOR_RGBA2RGB", ColorConversionCodes::COLOR_RGBA2RGB)
        .value("COLOR_BGR2RGBA", ColorConversionCodes::COLOR_BGR2RGBA)
        .value("COLOR_RGB2BGRA", ColorConversionCodes::COLOR_RGB2BGRA)
        .value("COLOR_RGBA2BGR", ColorConversionCodes::COLOR_RGBA2BGR)
        .value("COLOR_BGRA2RGB", ColorConversionCodes::COLOR_BGRA2RGB)
        .value("COLOR_BGR2RGB", ColorConversionCodes::COLOR_BGR2RGB)
        .value("COLOR_RGB2BGR", ColorConversionCodes::COLOR_RGB2BGR)
        .value("COLOR_BGRA2RGBA", ColorConversionCodes::COLOR_BGRA2RGBA)
        .value("COLOR_RGBA2BGRA", ColorConversionCodes::COLOR_RGBA2BGRA)
        .value("COLOR_BGR2GRAY", ColorConversionCodes::COLOR_BGR2GRAY)
        .value("COLOR_RGB2GRAY", ColorConversionCodes::COLOR_RGB2GRAY)
        .value("COLOR_GRAY2BGR", ColorConversionCodes::COLOR_GRAY2BGR)
        .value("COLOR_GRAY2RGB", ColorConversionCodes::COLOR_GRAY2RGB)
        .value("COLOR_GRAY2BGRA", ColorConversionCodes::COLOR_GRAY2BGRA)
        .value("COLOR_GRAY2RGBA", ColorConversionCodes::COLOR_GRAY2RGBA)
        .value("COLOR_BGRA2GRAY", ColorConversionCodes::COLOR_BGRA2GRAY)
        .value("COLOR_RGBA2GRAY", ColorConversionCodes::COLOR_RGBA2GRAY)
        .value("COLOR_BGR2BGR565", ColorConversionCodes::COLOR_BGR2BGR565)
        .value("COLOR_RGB2BGR565", ColorConversionCodes::COLOR_RGB2BGR565)
        .value("COLOR_BGR5652BGR", ColorConversionCodes::COLOR_BGR5652BGR)
        .value("COLOR_BGR5652RGB", ColorConversionCodes::COLOR_BGR5652RGB)
        .value("COLOR_BGRA2BGR565", ColorConversionCodes::COLOR_BGRA2BGR565)
        .value("COLOR_RGBA2BGR565", ColorConversionCodes::COLOR_RGBA2BGR565)
        .value("COLOR_BGR5652BGRA", ColorConversionCodes::COLOR_BGR5652BGRA)
        .value("COLOR_BGR5652RGBA", ColorConversionCodes::COLOR_BGR5652RGBA)
        .value("COLOR_GRAY2BGR565", ColorConversionCodes::COLOR_GRAY2BGR565)
        .value("COLOR_BGR5652GRAY", ColorConversionCodes::COLOR_BGR5652GRAY)
        .value("COLOR_BGR2BGR555", ColorConversionCodes::COLOR_BGR2BGR555)
        .value("COLOR_RGB2BGR555", ColorConversionCodes::COLOR_RGB2BGR555)
        .value("COLOR_BGR5552BGR", ColorConversionCodes::COLOR_BGR5552BGR)
        .value("COLOR_BGR5552RGB", ColorConversionCodes::COLOR_BGR5552RGB)
        .value("COLOR_BGRA2BGR555", ColorConversionCodes::COLOR_BGRA2BGR555)
        .value("COLOR_RGBA2BGR555", ColorConversionCodes::COLOR_RGBA2BGR555)
        .value("COLOR_BGR5552BGRA", ColorConversionCodes::COLOR_BGR5552BGRA)
        .value("COLOR_BGR5552RGBA", ColorConversionCodes::COLOR_BGR5552RGBA)
        .value("COLOR_GRAY2BGR555", ColorConversionCodes::COLOR_GRAY2BGR555)
        .value("COLOR_BGR5552GRAY", ColorConversionCodes::COLOR_BGR5552GRAY)
        .value("COLOR_BGR2XYZ", ColorConversionCodes::COLOR_BGR2XYZ)
        .value("COLOR_RGB2XYZ", ColorConversionCodes::COLOR_RGB2XYZ)
        .value("COLOR_XYZ2BGR", ColorConversionCodes::COLOR_XYZ2BGR)
        .value("COLOR_XYZ2RGB", ColorConversionCodes::COLOR_XYZ2RGB)
        .value("COLOR_BGR2YCrCb", ColorConversionCodes::COLOR_BGR2YCrCb)
        .value("COLOR_RGB2YCrCb", ColorConversionCodes::COLOR_RGB2YCrCb)
        .value("COLOR_YCrCb2BGR", ColorConversionCodes::COLOR_YCrCb2BGR)
        .value("COLOR_YCrCb2RGB", ColorConversionCodes::COLOR_YCrCb2RGB)
        .value("COLOR_BGR2HSV", ColorConversionCodes::COLOR_BGR2HSV)
        .value("COLOR_RGB2HSV", ColorConversionCodes::COLOR_RGB2HSV)
        .value("COLOR_BGR2Lab", ColorConversionCodes::COLOR_BGR2Lab)
        .value("COLOR_RGB2Lab", ColorConversionCodes::COLOR_RGB2Lab)
        .value("COLOR_BGR2Luv", ColorConversionCodes::COLOR_BGR2Luv)
        .value("COLOR_RGB2Luv", ColorConversionCodes::COLOR_RGB2Luv)
        .value("COLOR_BGR2HLS", ColorConversionCodes::COLOR_BGR2HLS)
        .value("COLOR_RGB2HLS", ColorConversionCodes::COLOR_RGB2HLS)
        .value("COLOR_HSV2BGR", ColorConversionCodes::COLOR_HSV2BGR)
        .value("COLOR_HSV2RGB", ColorConversionCodes::COLOR_HSV2RGB)
        .value("COLOR_Lab2BGR", ColorConversionCodes::COLOR_Lab2BGR)
        .value("COLOR_Lab2RGB", ColorConversionCodes::COLOR_Lab2RGB)
        .value("COLOR_Luv2BGR", ColorConversionCodes::COLOR_Luv2BGR)
        .value("COLOR_Luv2RGB", ColorConversionCodes::COLOR_Luv2RGB)
        .value("COLOR_HLS2BGR", ColorConversionCodes::COLOR_HLS2BGR)
        .value("COLOR_HLS2RGB", ColorConversionCodes::COLOR_HLS2RGB)
        .value("COLOR_BGR2HSV_FULL", ColorConversionCodes::COLOR_BGR2HSV_FULL)
        .value("COLOR_RGB2HSV_FULL", ColorConversionCodes::COLOR_RGB2HSV_FULL)
        .value("COLOR_BGR2HLS_FULL", ColorConversionCodes::COLOR_BGR2HLS_FULL)
        .value("COLOR_RGB2HLS_FULL", ColorConversionCodes::COLOR_RGB2HLS_FULL)
        .value("COLOR_HSV2BGR_FULL", ColorConversionCodes::COLOR_HSV2BGR_FULL)
        .value("COLOR_HSV2RGB_FULL", ColorConversionCodes::COLOR_HSV2RGB_FULL)
        .value("COLOR_HLS2BGR_FULL", ColorConversionCodes::COLOR_HLS2BGR_FULL)
        .value("COLOR_HLS2RGB_FULL", ColorConversionCodes::COLOR_HLS2RGB_FULL)
        .value("COLOR_LBGR2Lab", ColorConversionCodes::COLOR_LBGR2Lab)
        .value("COLOR_LRGB2Lab", ColorConversionCodes::COLOR_LRGB2Lab)
        .value("COLOR_LBGR2Luv", ColorConversionCodes::COLOR_LBGR2Luv)
        .value("COLOR_LRGB2Luv", ColorConversionCodes::COLOR_LRGB2Luv)
        .value("COLOR_Lab2LBGR", ColorConversionCodes::COLOR_Lab2LBGR)
        .value("COLOR_Lab2LRGB", ColorConversionCodes::COLOR_Lab2LRGB)
        .value("COLOR_Luv2LBGR", ColorConversionCodes::COLOR_Luv2LBGR)
        .value("COLOR_Luv2LRGB", ColorConversionCodes::COLOR_Luv2LRGB)
        .value("COLOR_BGR2YUV", ColorConversionCodes::COLOR_BGR2YUV)
        .value("COLOR_RGB2YUV", ColorConversionCodes::COLOR_RGB2YUV)
        .value("COLOR_YUV2BGR", ColorConversionCodes::COLOR_YUV2BGR)
        .value("COLOR_YUV2RGB", ColorConversionCodes::COLOR_YUV2RGB)
        .value("COLOR_YUV2RGB_NV12", ColorConversionCodes::COLOR_YUV2RGB_NV12)
        .value("COLOR_YUV2BGR_NV12", ColorConversionCodes::COLOR_YUV2BGR_NV12)
        .value("COLOR_YUV2RGB_NV21", ColorConversionCodes::COLOR_YUV2RGB_NV21)
        .value("COLOR_YUV2BGR_NV21", ColorConversionCodes::COLOR_YUV2BGR_NV21)
        .value("COLOR_YUV420sp2RGB", ColorConversionCodes::COLOR_YUV420sp2RGB)
        .value("COLOR_YUV420sp2BGR", ColorConversionCodes::COLOR_YUV420sp2BGR)
        .value("COLOR_YUV2RGBA_NV12", ColorConversionCodes::COLOR_YUV2RGBA_NV12)
        .value("COLOR_YUV2BGRA_NV12", ColorConversionCodes::COLOR_YUV2BGRA_NV12)
        .value("COLOR_YUV2RGBA_NV21", ColorConversionCodes::COLOR_YUV2RGBA_NV21)
        .value("COLOR_YUV2BGRA_NV21", ColorConversionCodes::COLOR_YUV2BGRA_NV21)
        .value("COLOR_YUV420sp2RGBA", ColorConversionCodes::COLOR_YUV420sp2RGBA)
        .value("COLOR_YUV420sp2BGRA", ColorConversionCodes::COLOR_YUV420sp2BGRA)
        .value("COLOR_YUV2RGB_YV12", ColorConversionCodes::COLOR_YUV2RGB_YV12)
        .value("COLOR_YUV2BGR_YV12", ColorConversionCodes::COLOR_YUV2BGR_YV12)
        .value("COLOR_YUV2RGB_IYUV", ColorConversionCodes::COLOR_YUV2RGB_IYUV)
        .value("COLOR_YUV2BGR_IYUV", ColorConversionCodes::COLOR_YUV2BGR_IYUV)
        .value("COLOR_YUV2RGB_I420", ColorConversionCodes::COLOR_YUV2RGB_I420)
        .value("COLOR_YUV2BGR_I420", ColorConversionCodes::COLOR_YUV2BGR_I420)
        .value("COLOR_YUV420p2RGB", ColorConversionCodes::COLOR_YUV420p2RGB)
        .value("COLOR_YUV420p2BGR", ColorConversionCodes::COLOR_YUV420p2BGR)
        .value("COLOR_YUV2RGBA_YV12", ColorConversionCodes::COLOR_YUV2RGBA_YV12)
        .value("COLOR_YUV2BGRA_YV12", ColorConversionCodes::COLOR_YUV2BGRA_YV12)
        .value("COLOR_YUV2RGBA_IYUV", ColorConversionCodes::COLOR_YUV2RGBA_IYUV)
        .value("COLOR_YUV2BGRA_IYUV", ColorConversionCodes::COLOR_YUV2BGRA_IYUV)
        .value("COLOR_YUV2RGBA_I420", ColorConversionCodes::COLOR_YUV2RGBA_I420)
        .value("COLOR_YUV2BGRA_I420", ColorConversionCodes::COLOR_YUV2BGRA_I420)
        .value("COLOR_YUV420p2RGBA", ColorConversionCodes::COLOR_YUV420p2RGBA)
        .value("COLOR_YUV420p2BGRA", ColorConversionCodes::COLOR_YUV420p2BGRA)
        .value("COLOR_YUV2GRAY_420", ColorConversionCodes::COLOR_YUV2GRAY_420)
        .value("COLOR_YUV2GRAY_NV21", ColorConversionCodes::COLOR_YUV2GRAY_NV21)
        .value("COLOR_YUV2GRAY_NV12", ColorConversionCodes::COLOR_YUV2GRAY_NV12)
        .value("COLOR_YUV2GRAY_YV12", ColorConversionCodes::COLOR_YUV2GRAY_YV12)
        .value("COLOR_YUV2GRAY_IYUV", ColorConversionCodes::COLOR_YUV2GRAY_IYUV)
        .value("COLOR_YUV2GRAY_I420", ColorConversionCodes::COLOR_YUV2GRAY_I420)
        .value("COLOR_YUV420sp2GRAY", ColorConversionCodes::COLOR_YUV420sp2GRAY)
        .value("COLOR_YUV420p2GRAY", ColorConversionCodes::COLOR_YUV420p2GRAY)
        .value("COLOR_YUV2RGB_UYVY", ColorConversionCodes::COLOR_YUV2RGB_UYVY)
        .value("COLOR_YUV2BGR_UYVY", ColorConversionCodes::COLOR_YUV2BGR_UYVY)
        .value("COLOR_YUV2RGB_Y422", ColorConversionCodes::COLOR_YUV2RGB_Y422)
        .value("COLOR_YUV2BGR_Y422", ColorConversionCodes::COLOR_YUV2BGR_Y422)
        .value("COLOR_YUV2RGB_UYNV", ColorConversionCodes::COLOR_YUV2RGB_UYNV)
        .value("COLOR_YUV2BGR_UYNV", ColorConversionCodes::COLOR_YUV2BGR_UYNV)
        .value("COLOR_YUV2RGBA_UYVY", ColorConversionCodes::COLOR_YUV2RGBA_UYVY)
        .value("COLOR_YUV2BGRA_UYVY", ColorConversionCodes::COLOR_YUV2BGRA_UYVY)
        .value("COLOR_YUV2RGBA_Y422", ColorConversionCodes::COLOR_YUV2RGBA_Y422)
        .value("COLOR_YUV2BGRA_Y422", ColorConversionCodes::COLOR_YUV2BGRA_Y422)
        .value("COLOR_YUV2RGBA_UYNV", ColorConversionCodes::COLOR_YUV2RGBA_UYNV)
        .value("COLOR_YUV2BGRA_UYNV", ColorConversionCodes::COLOR_YUV2BGRA_UYNV)
        .value("COLOR_YUV2RGB_YUY2", ColorConversionCodes::COLOR_YUV2RGB_YUY2)
        .value("COLOR_YUV2BGR_YUY2", ColorConversionCodes::COLOR_YUV2BGR_YUY2)
        .value("COLOR_YUV2RGB_YVYU", ColorConversionCodes::COLOR_YUV2RGB_YVYU)
        .value("COLOR_YUV2BGR_YVYU", ColorConversionCodes::COLOR_YUV2BGR_YVYU)
        .value("COLOR_YUV2RGB_YUYV", ColorConversionCodes::COLOR_YUV2RGB_YUYV)
        .value("COLOR_YUV2BGR_YUYV", ColorConversionCodes::COLOR_YUV2BGR_YUYV)
        .value("COLOR_YUV2RGB_YUNV", ColorConversionCodes::COLOR_YUV2RGB_YUNV)
        .value("COLOR_YUV2BGR_YUNV", ColorConversionCodes::COLOR_YUV2BGR_YUNV)
        .value("COLOR_YUV2RGBA_YUY2", ColorConversionCodes::COLOR_YUV2RGBA_YUY2)
        .value("COLOR_YUV2BGRA_YUY2", ColorConversionCodes::COLOR_YUV2BGRA_YUY2)
        .value("COLOR_YUV2RGBA_YVYU", ColorConversionCodes::COLOR_YUV2RGBA_YVYU)
        .value("COLOR_YUV2BGRA_YVYU", ColorConversionCodes::COLOR_YUV2BGRA_YVYU)
        .value("COLOR_YUV2RGBA_YUYV", ColorConversionCodes::COLOR_YUV2RGBA_YUYV)
        .value("COLOR_YUV2BGRA_YUYV", ColorConversionCodes::COLOR_YUV2BGRA_YUYV)
        .value("COLOR_YUV2RGBA_YUNV", ColorConversionCodes::COLOR_YUV2RGBA_YUNV)
        .value("COLOR_YUV2BGRA_YUNV", ColorConversionCodes::COLOR_YUV2BGRA_YUNV)
        .value("COLOR_YUV2GRAY_UYVY", ColorConversionCodes::COLOR_YUV2GRAY_UYVY)
        .value("COLOR_YUV2GRAY_YUY2", ColorConversionCodes::COLOR_YUV2GRAY_YUY2)
        .value("COLOR_YUV2GRAY_Y422", ColorConversionCodes::COLOR_YUV2GRAY_Y422)
        .value("COLOR_YUV2GRAY_UYNV", ColorConversionCodes::COLOR_YUV2GRAY_UYNV)
        .value("COLOR_YUV2GRAY_YVYU", ColorConversionCodes::COLOR_YUV2GRAY_YVYU)
        .value("COLOR_YUV2GRAY_YUYV", ColorConversionCodes::COLOR_YUV2GRAY_YUYV)
        .value("COLOR_YUV2GRAY_YUNV", ColorConversionCodes::COLOR_YUV2GRAY_YUNV)
        .value("COLOR_RGBA2mRGBA", ColorConversionCodes::COLOR_RGBA2mRGBA)
        .value("COLOR_mRGBA2RGBA", ColorConversionCodes::COLOR_mRGBA2RGBA)
        .value("COLOR_RGB2YUV_I420", ColorConversionCodes::COLOR_RGB2YUV_I420)
        .value("COLOR_BGR2YUV_I420", ColorConversionCodes::COLOR_BGR2YUV_I420)
        .value("COLOR_RGB2YUV_IYUV", ColorConversionCodes::COLOR_RGB2YUV_IYUV)
        .value("COLOR_BGR2YUV_IYUV", ColorConversionCodes::COLOR_BGR2YUV_IYUV)
        .value("COLOR_RGBA2YUV_I420", ColorConversionCodes::COLOR_RGBA2YUV_I420)
        .value("COLOR_BGRA2YUV_I420", ColorConversionCodes::COLOR_BGRA2YUV_I420)
        .value("COLOR_RGBA2YUV_IYUV", ColorConversionCodes::COLOR_RGBA2YUV_IYUV)
        .value("COLOR_BGRA2YUV_IYUV", ColorConversionCodes::COLOR_BGRA2YUV_IYUV)
        .value("COLOR_RGB2YUV_YV12", ColorConversionCodes::COLOR_RGB2YUV_YV12)
        .value("COLOR_BGR2YUV_YV12", ColorConversionCodes::COLOR_BGR2YUV_YV12)
        .value("COLOR_RGBA2YUV_YV12", ColorConversionCodes::COLOR_RGBA2YUV_YV12)
        .value("COLOR_BGRA2YUV_YV12", ColorConversionCodes::COLOR_BGRA2YUV_YV12)
        .value("COLOR_BayerBG2BGR", ColorConversionCodes::COLOR_BayerBG2BGR)
        .value("COLOR_BayerGB2BGR", ColorConversionCodes::COLOR_BayerGB2BGR)
        .value("COLOR_BayerRG2BGR", ColorConversionCodes::COLOR_BayerRG2BGR)
        .value("COLOR_BayerGR2BGR", ColorConversionCodes::COLOR_BayerGR2BGR)
        .value("COLOR_BayerRGGB2BGR", ColorConversionCodes::COLOR_BayerRGGB2BGR)
        .value("COLOR_BayerGRBG2BGR", ColorConversionCodes::COLOR_BayerGRBG2BGR)
        .value("COLOR_BayerBGGR2BGR", ColorConversionCodes::COLOR_BayerBGGR2BGR)
        .value("COLOR_BayerGBRG2BGR", ColorConversionCodes::COLOR_BayerGBRG2BGR)
        .value("COLOR_BayerRGGB2RGB", ColorConversionCodes::COLOR_BayerRGGB2RGB)
        .value("COLOR_BayerGRBG2RGB", ColorConversionCodes::COLOR_BayerGRBG2RGB)
        .value("COLOR_BayerBGGR2RGB", ColorConversionCodes::COLOR_BayerBGGR2RGB)
        .value("COLOR_BayerGBRG2RGB", ColorConversionCodes::COLOR_BayerGBRG2RGB)
        .value("COLOR_BayerBG2RGB", ColorConversionCodes::COLOR_BayerBG2RGB)
        .value("COLOR_BayerGB2RGB", ColorConversionCodes::COLOR_BayerGB2RGB)
        .value("COLOR_BayerRG2RGB", ColorConversionCodes::COLOR_BayerRG2RGB)
        .value("COLOR_BayerGR2RGB", ColorConversionCodes::COLOR_BayerGR2RGB)
        .value("COLOR_BayerBG2GRAY", ColorConversionCodes::COLOR_BayerBG2GRAY)
        .value("COLOR_BayerGB2GRAY", ColorConversionCodes::COLOR_BayerGB2GRAY)
        .value("COLOR_BayerRG2GRAY", ColorConversionCodes::COLOR_BayerRG2GRAY)
        .value("COLOR_BayerGR2GRAY", ColorConversionCodes::COLOR_BayerGR2GRAY)
        .value("COLOR_BayerRGGB2GRAY", ColorConversionCodes::COLOR_BayerRGGB2GRAY)
        .value("COLOR_BayerGRBG2GRAY", ColorConversionCodes::COLOR_BayerGRBG2GRAY)
        .value("COLOR_BayerBGGR2GRAY", ColorConversionCodes::COLOR_BayerBGGR2GRAY)
        .value("COLOR_BayerGBRG2GRAY", ColorConversionCodes::COLOR_BayerGBRG2GRAY)
        .value("COLOR_BayerBG2BGR_VNG", ColorConversionCodes::COLOR_BayerBG2BGR_VNG)
        .value("COLOR_BayerGB2BGR_VNG", ColorConversionCodes::COLOR_BayerGB2BGR_VNG)
        .value("COLOR_BayerRG2BGR_VNG", ColorConversionCodes::COLOR_BayerRG2BGR_VNG)
        .value("COLOR_BayerGR2BGR_VNG", ColorConversionCodes::COLOR_BayerGR2BGR_VNG)
        .value("COLOR_BayerRGGB2BGR_VNG", ColorConversionCodes::COLOR_BayerRGGB2BGR_VNG)
        .value("COLOR_BayerGRBG2BGR_VNG", ColorConversionCodes::COLOR_BayerGRBG2BGR_VNG)
        .value("COLOR_BayerBGGR2BGR_VNG", ColorConversionCodes::COLOR_BayerBGGR2BGR_VNG)
        .value("COLOR_BayerGBRG2BGR_VNG", ColorConversionCodes::COLOR_BayerGBRG2BGR_VNG)
        .value("COLOR_BayerRGGB2RGB_VNG", ColorConversionCodes::COLOR_BayerRGGB2RGB_VNG)
        .value("COLOR_BayerGRBG2RGB_VNG", ColorConversionCodes::COLOR_BayerGRBG2RGB_VNG)
        .value("COLOR_BayerBGGR2RGB_VNG", ColorConversionCodes::COLOR_BayerBGGR2RGB_VNG)
        .value("COLOR_BayerGBRG2RGB_VNG", ColorConversionCodes::COLOR_BayerGBRG2RGB_VNG)
        .value("COLOR_BayerBG2RGB_VNG", ColorConversionCodes::COLOR_BayerBG2RGB_VNG)
        .value("COLOR_BayerGB2RGB_VNG", ColorConversionCodes::COLOR_BayerGB2RGB_VNG)
        .value("COLOR_BayerRG2RGB_VNG", ColorConversionCodes::COLOR_BayerRG2RGB_VNG)
        .value("COLOR_BayerGR2RGB_VNG", ColorConversionCodes::COLOR_BayerGR2RGB_VNG)
        .value("COLOR_BayerBG2BGR_EA", ColorConversionCodes::COLOR_BayerBG2BGR_EA)
        .value("COLOR_BayerGB2BGR_EA", ColorConversionCodes::COLOR_BayerGB2BGR_EA)
        .value("COLOR_BayerRG2BGR_EA", ColorConversionCodes::COLOR_BayerRG2BGR_EA)
        .value("COLOR_BayerGR2BGR_EA", ColorConversionCodes::COLOR_BayerGR2BGR_EA)
        .value("COLOR_BayerRGGB2BGR_EA", ColorConversionCodes::COLOR_BayerRGGB2BGR_EA)
        .value("COLOR_BayerGRBG2BGR_EA", ColorConversionCodes::COLOR_BayerGRBG2BGR_EA)
        .value("COLOR_BayerBGGR2BGR_EA", ColorConversionCodes::COLOR_BayerBGGR2BGR_EA)
        .value("COLOR_BayerGBRG2BGR_EA", ColorConversionCodes::COLOR_BayerGBRG2BGR_EA)
        .value("COLOR_BayerRGGB2RGB_EA", ColorConversionCodes::COLOR_BayerRGGB2RGB_EA)
        .value("COLOR_BayerGRBG2RGB_EA", ColorConversionCodes::COLOR_BayerGRBG2RGB_EA)
        .value("COLOR_BayerBGGR2RGB_EA", ColorConversionCodes::COLOR_BayerBGGR2RGB_EA)
        .value("COLOR_BayerGBRG2RGB_EA", ColorConversionCodes::COLOR_BayerGBRG2RGB_EA)
        .value("COLOR_BayerBG2RGB_EA", ColorConversionCodes::COLOR_BayerBG2RGB_EA)
        .value("COLOR_BayerGB2RGB_EA", ColorConversionCodes::COLOR_BayerGB2RGB_EA)
        .value("COLOR_BayerRG2RGB_EA", ColorConversionCodes::COLOR_BayerRG2RGB_EA)
        .value("COLOR_BayerGR2RGB_EA", ColorConversionCodes::COLOR_BayerGR2RGB_EA)
        .value("COLOR_BayerBG2BGRA", ColorConversionCodes::COLOR_BayerBG2BGRA)
        .value("COLOR_BayerGB2BGRA", ColorConversionCodes::COLOR_BayerGB2BGRA)
        .value("COLOR_BayerRG2BGRA", ColorConversionCodes::COLOR_BayerRG2BGRA)
        .value("COLOR_BayerGR2BGRA", ColorConversionCodes::COLOR_BayerGR2BGRA)
        .value("COLOR_BayerRGGB2BGRA", ColorConversionCodes::COLOR_BayerRGGB2BGRA)
        .value("COLOR_BayerGRBG2BGRA", ColorConversionCodes::COLOR_BayerGRBG2BGRA)
        .value("COLOR_BayerBGGR2BGRA", ColorConversionCodes::COLOR_BayerBGGR2BGRA)
        .value("COLOR_BayerGBRG2BGRA", ColorConversionCodes::COLOR_BayerGBRG2BGRA)
        .value("COLOR_BayerRGGB2RGBA", ColorConversionCodes::COLOR_BayerRGGB2RGBA)
        .value("COLOR_BayerGRBG2RGBA", ColorConversionCodes::COLOR_BayerGRBG2RGBA)
        .value("COLOR_BayerBGGR2RGBA", ColorConversionCodes::COLOR_BayerBGGR2RGBA)
        .value("COLOR_BayerGBRG2RGBA", ColorConversionCodes::COLOR_BayerGBRG2RGBA)
        .value("COLOR_BayerBG2RGBA", ColorConversionCodes::COLOR_BayerBG2RGBA)
        .value("COLOR_BayerGB2RGBA", ColorConversionCodes::COLOR_BayerGB2RGBA)
        .value("COLOR_BayerRG2RGBA", ColorConversionCodes::COLOR_BayerRG2RGBA)
        .value("COLOR_BayerGR2RGBA", ColorConversionCodes::COLOR_BayerGR2RGBA)
        .value("COLOR_RGB2YUV_UYVY", ColorConversionCodes::COLOR_RGB2YUV_UYVY)
        .value("COLOR_BGR2YUV_UYVY", ColorConversionCodes::COLOR_BGR2YUV_UYVY)
        .value("COLOR_RGB2YUV_Y422", ColorConversionCodes::COLOR_RGB2YUV_Y422)
        .value("COLOR_BGR2YUV_Y422", ColorConversionCodes::COLOR_BGR2YUV_Y422)
        .value("COLOR_RGB2YUV_UYNV", ColorConversionCodes::COLOR_RGB2YUV_UYNV)
        .value("COLOR_BGR2YUV_UYNV", ColorConversionCodes::COLOR_BGR2YUV_UYNV)
        .value("COLOR_RGBA2YUV_UYVY", ColorConversionCodes::COLOR_RGBA2YUV_UYVY)
        .value("COLOR_BGRA2YUV_UYVY", ColorConversionCodes::COLOR_BGRA2YUV_UYVY)
        .value("COLOR_RGBA2YUV_Y422", ColorConversionCodes::COLOR_RGBA2YUV_Y422)
        .value("COLOR_BGRA2YUV_Y422", ColorConversionCodes::COLOR_BGRA2YUV_Y422)
        .value("COLOR_RGBA2YUV_UYNV", ColorConversionCodes::COLOR_RGBA2YUV_UYNV)
        .value("COLOR_BGRA2YUV_UYNV", ColorConversionCodes::COLOR_BGRA2YUV_UYNV)
        .value("COLOR_RGB2YUV_YUY2", ColorConversionCodes::COLOR_RGB2YUV_YUY2)
        .value("COLOR_BGR2YUV_YUY2", ColorConversionCodes::COLOR_BGR2YUV_YUY2)
        .value("COLOR_RGB2YUV_YVYU", ColorConversionCodes::COLOR_RGB2YUV_YVYU)
        .value("COLOR_BGR2YUV_YVYU", ColorConversionCodes::COLOR_BGR2YUV_YVYU)
        .value("COLOR_RGB2YUV_YUYV", ColorConversionCodes::COLOR_RGB2YUV_YUYV)
        .value("COLOR_BGR2YUV_YUYV", ColorConversionCodes::COLOR_BGR2YUV_YUYV)
        .value("COLOR_RGB2YUV_YUNV", ColorConversionCodes::COLOR_RGB2YUV_YUNV)
        .value("COLOR_BGR2YUV_YUNV", ColorConversionCodes::COLOR_BGR2YUV_YUNV)
        .value("COLOR_RGBA2YUV_YUY2", ColorConversionCodes::COLOR_RGBA2YUV_YUY2)
        .value("COLOR_BGRA2YUV_YUY2", ColorConversionCodes::COLOR_BGRA2YUV_YUY2)
        .value("COLOR_RGBA2YUV_YVYU", ColorConversionCodes::COLOR_RGBA2YUV_YVYU)
        .value("COLOR_BGRA2YUV_YVYU", ColorConversionCodes::COLOR_BGRA2YUV_YVYU)
        .value("COLOR_RGBA2YUV_YUYV", ColorConversionCodes::COLOR_RGBA2YUV_YUYV)
        .value("COLOR_BGRA2YUV_YUYV", ColorConversionCodes::COLOR_BGRA2YUV_YUYV)
        .value("COLOR_RGBA2YUV_YUNV", ColorConversionCodes::COLOR_RGBA2YUV_YUNV)
        .value("COLOR_BGRA2YUV_YUNV", ColorConversionCodes::COLOR_BGRA2YUV_YUNV)
        .value("COLOR_COLORCVT_MAX", ColorConversionCodes::COLOR_COLORCVT_MAX);

    emscripten::enum_<ColormapTypes>("ColormapTypes")
        .value("COLORMAP_AUTUMN", ColormapTypes::COLORMAP_AUTUMN)
        .value("COLORMAP_BONE", ColormapTypes::COLORMAP_BONE)
        .value("COLORMAP_JET", ColormapTypes::COLORMAP_JET)
        .value("COLORMAP_WINTER", ColormapTypes::COLORMAP_WINTER)
        .value("COLORMAP_RAINBOW", ColormapTypes::COLORMAP_RAINBOW)
        .value("COLORMAP_OCEAN", ColormapTypes::COLORMAP_OCEAN)
        .value("COLORMAP_SUMMER", ColormapTypes::COLORMAP_SUMMER)
        .value("COLORMAP_SPRING", ColormapTypes::COLORMAP_SPRING)
        .value("COLORMAP_COOL", ColormapTypes::COLORMAP_COOL)
        .value("COLORMAP_HSV", ColormapTypes::COLORMAP_HSV)
        .value("COLORMAP_PINK", ColormapTypes::COLORMAP_PINK)
        .value("COLORMAP_HOT", ColormapTypes::COLORMAP_HOT)
        .value("COLORMAP_PARULA", ColormapTypes::COLORMAP_PARULA)
        .value("COLORMAP_MAGMA", ColormapTypes::COLORMAP_MAGMA)
        .value("COLORMAP_INFERNO", ColormapTypes::COLORMAP_INFERNO)
        .value("COLORMAP_PLASMA", ColormapTypes::COLORMAP_PLASMA)
        .value("COLORMAP_VIRIDIS", ColormapTypes::COLORMAP_VIRIDIS)
        .value("COLORMAP_CIVIDIS", ColormapTypes::COLORMAP_CIVIDIS)
        .value("COLORMAP_TWILIGHT", ColormapTypes::COLORMAP_TWILIGHT)
        .value("COLORMAP_TWILIGHT_SHIFTED", ColormapTypes::COLORMAP_TWILIGHT_SHIFTED)
        .value("COLORMAP_TURBO", ColormapTypes::COLORMAP_TURBO)
        .value("COLORMAP_DEEPGREEN", ColormapTypes::COLORMAP_DEEPGREEN);

    emscripten::enum_<ConnectedComponentsAlgorithmsTypes>("ConnectedComponentsAlgorithmsTypes")
        .value("CCL_DEFAULT", ConnectedComponentsAlgorithmsTypes::CCL_DEFAULT)
        .value("CCL_WU", ConnectedComponentsAlgorithmsTypes::CCL_WU)
        .value("CCL_GRANA", ConnectedComponentsAlgorithmsTypes::CCL_GRANA)
        .value("CCL_BOLELLI", ConnectedComponentsAlgorithmsTypes::CCL_BOLELLI)
        .value("CCL_SAUF", ConnectedComponentsAlgorithmsTypes::CCL_SAUF)
        .value("CCL_BBDT", ConnectedComponentsAlgorithmsTypes::CCL_BBDT)
        .value("CCL_SPAGHETTI", ConnectedComponentsAlgorithmsTypes::CCL_SPAGHETTI);

    emscripten::enum_<ConnectedComponentsTypes>("ConnectedComponentsTypes")
        .value("CC_STAT_LEFT", ConnectedComponentsTypes::CC_STAT_LEFT)
        .value("CC_STAT_TOP", ConnectedComponentsTypes::CC_STAT_TOP)
        .value("CC_STAT_WIDTH", ConnectedComponentsTypes::CC_STAT_WIDTH)
        .value("CC_STAT_HEIGHT", ConnectedComponentsTypes::CC_STAT_HEIGHT)
        .value("CC_STAT_AREA", ConnectedComponentsTypes::CC_STAT_AREA)
        .value("CC_STAT_MAX", ConnectedComponentsTypes::CC_STAT_MAX);

    emscripten::enum_<ContourApproximationModes>("ContourApproximationModes")
        .value("CHAIN_APPROX_NONE", ContourApproximationModes::CHAIN_APPROX_NONE)
        .value("CHAIN_APPROX_SIMPLE", ContourApproximationModes::CHAIN_APPROX_SIMPLE)
        .value("CHAIN_APPROX_TC89_L1", ContourApproximationModes::CHAIN_APPROX_TC89_L1)
        .value("CHAIN_APPROX_TC89_KCOS", ContourApproximationModes::CHAIN_APPROX_TC89_KCOS);

    emscripten::enum_<CovarFlags>("CovarFlags")
        .value("COVAR_SCRAMBLED", CovarFlags::COVAR_SCRAMBLED)
        .value("COVAR_NORMAL", CovarFlags::COVAR_NORMAL)
        .value("COVAR_USE_AVG", CovarFlags::COVAR_USE_AVG)
        .value("COVAR_SCALE", CovarFlags::COVAR_SCALE)
        .value("COVAR_ROWS", CovarFlags::COVAR_ROWS)
        .value("COVAR_COLS", CovarFlags::COVAR_COLS);

    emscripten::enum_<DecompTypes>("DecompTypes")
        .value("DECOMP_LU", DecompTypes::DECOMP_LU)
        .value("DECOMP_SVD", DecompTypes::DECOMP_SVD)
        .value("DECOMP_EIG", DecompTypes::DECOMP_EIG)
        .value("DECOMP_CHOLESKY", DecompTypes::DECOMP_CHOLESKY)
        .value("DECOMP_QR", DecompTypes::DECOMP_QR)
        .value("DECOMP_NORMAL", DecompTypes::DECOMP_NORMAL);

    emscripten::enum_<DescriptorMatcher::MatcherType>("DescriptorMatcher_MatcherType")
        .value("FLANNBASED", DescriptorMatcher::MatcherType::FLANNBASED)
        .value("BRUTEFORCE", DescriptorMatcher::MatcherType::BRUTEFORCE)
        .value("BRUTEFORCE_L1", DescriptorMatcher::MatcherType::BRUTEFORCE_L1)
        .value("BRUTEFORCE_HAMMING", DescriptorMatcher::MatcherType::BRUTEFORCE_HAMMING)
        .value("BRUTEFORCE_HAMMINGLUT", DescriptorMatcher::MatcherType::BRUTEFORCE_HAMMINGLUT)
        .value("BRUTEFORCE_SL2", DescriptorMatcher::MatcherType::BRUTEFORCE_SL2);

    emscripten::enum_<DftFlags>("DftFlags")
        .value("DFT_INVERSE", DftFlags::DFT_INVERSE)
        .value("DFT_SCALE", DftFlags::DFT_SCALE)
        .value("DFT_ROWS", DftFlags::DFT_ROWS)
        .value("DFT_COMPLEX_OUTPUT", DftFlags::DFT_COMPLEX_OUTPUT)
        .value("DFT_REAL_OUTPUT", DftFlags::DFT_REAL_OUTPUT)
        .value("DFT_COMPLEX_INPUT", DftFlags::DFT_COMPLEX_INPUT)
        .value("DCT_INVERSE", DftFlags::DCT_INVERSE)
        .value("DCT_ROWS", DftFlags::DCT_ROWS);

    emscripten::enum_<DistanceTransformLabelTypes>("DistanceTransformLabelTypes")
        .value("DIST_LABEL_CCOMP", DistanceTransformLabelTypes::DIST_LABEL_CCOMP)
        .value("DIST_LABEL_PIXEL", DistanceTransformLabelTypes::DIST_LABEL_PIXEL);

    emscripten::enum_<DistanceTransformMasks>("DistanceTransformMasks")
        .value("DIST_MASK_3", DistanceTransformMasks::DIST_MASK_3)
        .value("DIST_MASK_5", DistanceTransformMasks::DIST_MASK_5)
        .value("DIST_MASK_PRECISE", DistanceTransformMasks::DIST_MASK_PRECISE);

    emscripten::enum_<DistanceTypes>("DistanceTypes")
        .value("DIST_USER", DistanceTypes::DIST_USER)
        .value("DIST_L1", DistanceTypes::DIST_L1)
        .value("DIST_L2", DistanceTypes::DIST_L2)
        .value("DIST_C", DistanceTypes::DIST_C)
        .value("DIST_L12", DistanceTypes::DIST_L12)
        .value("DIST_FAIR", DistanceTypes::DIST_FAIR)
        .value("DIST_WELSCH", DistanceTypes::DIST_WELSCH)
        .value("DIST_HUBER", DistanceTypes::DIST_HUBER);

    emscripten::enum_<DrawMatchesFlags>("DrawMatchesFlags")
        .value("DEFAULT", DrawMatchesFlags::DEFAULT)
        .value("DRAW_OVER_OUTIMG", DrawMatchesFlags::DRAW_OVER_OUTIMG)
        .value("NOT_DRAW_SINGLE_POINTS", DrawMatchesFlags::NOT_DRAW_SINGLE_POINTS)
        .value("DRAW_RICH_KEYPOINTS", DrawMatchesFlags::DRAW_RICH_KEYPOINTS);

    emscripten::enum_<FaceRecognizerSF::DisType>("FaceRecognizerSF_DisType")
        .value("FR_COSINE", FaceRecognizerSF::DisType::FR_COSINE)
        .value("FR_NORM_L2", FaceRecognizerSF::DisType::FR_NORM_L2);

    emscripten::enum_<FastFeatureDetector::DetectorType>("FastFeatureDetector_DetectorType")
        .value("TYPE_5_8", FastFeatureDetector::DetectorType::TYPE_5_8)
        .value("TYPE_7_12", FastFeatureDetector::DetectorType::TYPE_7_12)
        .value("TYPE_9_16", FastFeatureDetector::DetectorType::TYPE_9_16);

    emscripten::enum_<FileStorage::Mode>("FileStorage_Mode")
        .value("READ", FileStorage::Mode::READ)
        .value("WRITE", FileStorage::Mode::WRITE)
        .value("APPEND", FileStorage::Mode::APPEND)
        .value("MEMORY", FileStorage::Mode::MEMORY)
        .value("FORMAT_MASK", FileStorage::Mode::FORMAT_MASK)
        .value("FORMAT_AUTO", FileStorage::Mode::FORMAT_AUTO)
        .value("FORMAT_XML", FileStorage::Mode::FORMAT_XML)
        .value("FORMAT_YAML", FileStorage::Mode::FORMAT_YAML)
        .value("FORMAT_JSON", FileStorage::Mode::FORMAT_JSON)
        .value("BASE64", FileStorage::Mode::BASE64)
        .value("WRITE_BASE64", FileStorage::Mode::WRITE_BASE64);

    emscripten::enum_<FileStorage::State>("FileStorage_State")
        .value("UNDEFINED", FileStorage::State::UNDEFINED)
        .value("VALUE_EXPECTED", FileStorage::State::VALUE_EXPECTED)
        .value("NAME_EXPECTED", FileStorage::State::NAME_EXPECTED)
        .value("INSIDE_MAP", FileStorage::State::INSIDE_MAP);

    emscripten::enum_<FloodFillFlags>("FloodFillFlags")
        .value("FLOODFILL_FIXED_RANGE", FloodFillFlags::FLOODFILL_FIXED_RANGE)
        .value("FLOODFILL_MASK_ONLY", FloodFillFlags::FLOODFILL_MASK_ONLY);

    emscripten::enum_<Formatter::FormatType>("Formatter_FormatType")
        .value("FMT_DEFAULT", Formatter::FormatType::FMT_DEFAULT)
        .value("FMT_MATLAB", Formatter::FormatType::FMT_MATLAB)
        .value("FMT_CSV", Formatter::FormatType::FMT_CSV)
        .value("FMT_PYTHON", Formatter::FormatType::FMT_PYTHON)
        .value("FMT_NUMPY", Formatter::FormatType::FMT_NUMPY)
        .value("FMT_C", Formatter::FormatType::FMT_C);

    emscripten::enum_<GemmFlags>("GemmFlags")
        .value("GEMM_1_T", GemmFlags::GEMM_1_T)
        .value("GEMM_2_T", GemmFlags::GEMM_2_T)
        .value("GEMM_3_T", GemmFlags::GEMM_3_T);

    emscripten::enum_<GrabCutClasses>("GrabCutClasses")
        .value("GC_BGD", GrabCutClasses::GC_BGD)
        .value("GC_FGD", GrabCutClasses::GC_FGD)
        .value("GC_PR_BGD", GrabCutClasses::GC_PR_BGD)
        .value("GC_PR_FGD", GrabCutClasses::GC_PR_FGD);

    emscripten::enum_<GrabCutModes>("GrabCutModes")
        .value("GC_INIT_WITH_RECT", GrabCutModes::GC_INIT_WITH_RECT)
        .value("GC_INIT_WITH_MASK", GrabCutModes::GC_INIT_WITH_MASK)
        .value("GC_EVAL", GrabCutModes::GC_EVAL)
        .value("GC_EVAL_FREEZE_MODEL", GrabCutModes::GC_EVAL_FREEZE_MODEL);

    emscripten::enum_<HOGDescriptor::DescriptorStorageFormat>("HOGDescriptor_DescriptorStorageFormat")
        .value("DESCR_FORMAT_COL_BY_COL", HOGDescriptor::DescriptorStorageFormat::DESCR_FORMAT_COL_BY_COL)
        .value("DESCR_FORMAT_ROW_BY_ROW", HOGDescriptor::DescriptorStorageFormat::DESCR_FORMAT_ROW_BY_ROW);

    emscripten::enum_<HOGDescriptor::HistogramNormType>("HOGDescriptor_HistogramNormType")
        .value("L2Hys", HOGDescriptor::HistogramNormType::L2Hys);

    emscripten::enum_<HandEyeCalibrationMethod>("HandEyeCalibrationMethod")
        .value("CALIB_HAND_EYE_TSAI", HandEyeCalibrationMethod::CALIB_HAND_EYE_TSAI)
        .value("CALIB_HAND_EYE_PARK", HandEyeCalibrationMethod::CALIB_HAND_EYE_PARK)
        .value("CALIB_HAND_EYE_HORAUD", HandEyeCalibrationMethod::CALIB_HAND_EYE_HORAUD)
        .value("CALIB_HAND_EYE_ANDREFF", HandEyeCalibrationMethod::CALIB_HAND_EYE_ANDREFF)
        .value("CALIB_HAND_EYE_DANIILIDIS", HandEyeCalibrationMethod::CALIB_HAND_EYE_DANIILIDIS);

    emscripten::enum_<HersheyFonts>("HersheyFonts")
        .value("FONT_HERSHEY_SIMPLEX", HersheyFonts::FONT_HERSHEY_SIMPLEX)
        .value("FONT_HERSHEY_PLAIN", HersheyFonts::FONT_HERSHEY_PLAIN)
        .value("FONT_HERSHEY_DUPLEX", HersheyFonts::FONT_HERSHEY_DUPLEX)
        .value("FONT_HERSHEY_COMPLEX", HersheyFonts::FONT_HERSHEY_COMPLEX)
        .value("FONT_HERSHEY_TRIPLEX", HersheyFonts::FONT_HERSHEY_TRIPLEX)
        .value("FONT_HERSHEY_COMPLEX_SMALL", HersheyFonts::FONT_HERSHEY_COMPLEX_SMALL)
        .value("FONT_HERSHEY_SCRIPT_SIMPLEX", HersheyFonts::FONT_HERSHEY_SCRIPT_SIMPLEX)
        .value("FONT_HERSHEY_SCRIPT_COMPLEX", HersheyFonts::FONT_HERSHEY_SCRIPT_COMPLEX)
        .value("FONT_ITALIC", HersheyFonts::FONT_ITALIC);

    emscripten::enum_<HistCompMethods>("HistCompMethods")
        .value("HISTCMP_CORREL", HistCompMethods::HISTCMP_CORREL)
        .value("HISTCMP_CHISQR", HistCompMethods::HISTCMP_CHISQR)
        .value("HISTCMP_INTERSECT", HistCompMethods::HISTCMP_INTERSECT)
        .value("HISTCMP_BHATTACHARYYA", HistCompMethods::HISTCMP_BHATTACHARYYA)
        .value("HISTCMP_HELLINGER", HistCompMethods::HISTCMP_HELLINGER)
        .value("HISTCMP_CHISQR_ALT", HistCompMethods::HISTCMP_CHISQR_ALT)
        .value("HISTCMP_KL_DIV", HistCompMethods::HISTCMP_KL_DIV);

    emscripten::enum_<HoughModes>("HoughModes")
        .value("HOUGH_STANDARD", HoughModes::HOUGH_STANDARD)
        .value("HOUGH_PROBABILISTIC", HoughModes::HOUGH_PROBABILISTIC)
        .value("HOUGH_MULTI_SCALE", HoughModes::HOUGH_MULTI_SCALE)
        .value("HOUGH_GRADIENT", HoughModes::HOUGH_GRADIENT)
        .value("HOUGH_GRADIENT_ALT", HoughModes::HOUGH_GRADIENT_ALT);

    emscripten::enum_<InterpolationFlags>("InterpolationFlags")
        .value("INTER_NEAREST", InterpolationFlags::INTER_NEAREST)
        .value("INTER_LINEAR", InterpolationFlags::INTER_LINEAR)
        .value("INTER_CUBIC", InterpolationFlags::INTER_CUBIC)
        .value("INTER_AREA", InterpolationFlags::INTER_AREA)
        .value("INTER_LANCZOS4", InterpolationFlags::INTER_LANCZOS4)
        .value("INTER_LINEAR_EXACT", InterpolationFlags::INTER_LINEAR_EXACT)
        .value("INTER_NEAREST_EXACT", InterpolationFlags::INTER_NEAREST_EXACT)
        .value("INTER_MAX", InterpolationFlags::INTER_MAX)
        .value("WARP_FILL_OUTLIERS", InterpolationFlags::WARP_FILL_OUTLIERS)
        .value("WARP_INVERSE_MAP", InterpolationFlags::WARP_INVERSE_MAP)
        .value("WARP_RELATIVE_MAP", InterpolationFlags::WARP_RELATIVE_MAP);

    emscripten::enum_<InterpolationMasks>("InterpolationMasks")
        .value("INTER_BITS", InterpolationMasks::INTER_BITS)
        .value("INTER_BITS2", InterpolationMasks::INTER_BITS2)
        .value("INTER_TAB_SIZE", InterpolationMasks::INTER_TAB_SIZE)
        .value("INTER_TAB_SIZE2", InterpolationMasks::INTER_TAB_SIZE2);

    emscripten::enum_<KAZE::DiffusivityType>("KAZE_DiffusivityType")
        .value("DIFF_PM_G1", KAZE::DiffusivityType::DIFF_PM_G1)
        .value("DIFF_PM_G2", KAZE::DiffusivityType::DIFF_PM_G2)
        .value("DIFF_WEICKERT", KAZE::DiffusivityType::DIFF_WEICKERT)
        .value("DIFF_CHARBONNIER", KAZE::DiffusivityType::DIFF_CHARBONNIER);

    emscripten::enum_<KmeansFlags>("KmeansFlags")
        .value("KMEANS_RANDOM_CENTERS", KmeansFlags::KMEANS_RANDOM_CENTERS)
        .value("KMEANS_PP_CENTERS", KmeansFlags::KMEANS_PP_CENTERS)
        .value("KMEANS_USE_INITIAL_LABELS", KmeansFlags::KMEANS_USE_INITIAL_LABELS);

    emscripten::enum_<LineSegmentDetectorModes>("LineSegmentDetectorModes")
        .value("LSD_REFINE_NONE", LineSegmentDetectorModes::LSD_REFINE_NONE)
        .value("LSD_REFINE_STD", LineSegmentDetectorModes::LSD_REFINE_STD)
        .value("LSD_REFINE_ADV", LineSegmentDetectorModes::LSD_REFINE_ADV);

    emscripten::enum_<LineTypes>("LineTypes")
        .value("FILLED", LineTypes::FILLED)
        .value("LINE_4", LineTypes::LINE_4)
        .value("LINE_8", LineTypes::LINE_8)
        .value("LINE_AA", LineTypes::LINE_AA);

    emscripten::enum_<LocalOptimMethod>("LocalOptimMethod")
        .value("LOCAL_OPTIM_NULL", LocalOptimMethod::LOCAL_OPTIM_NULL)
        .value("LOCAL_OPTIM_INNER_LO", LocalOptimMethod::LOCAL_OPTIM_INNER_LO)
        .value("LOCAL_OPTIM_INNER_AND_ITER_LO", LocalOptimMethod::LOCAL_OPTIM_INNER_AND_ITER_LO)
        .value("LOCAL_OPTIM_GC", LocalOptimMethod::LOCAL_OPTIM_GC)
        .value("LOCAL_OPTIM_SIGMA", LocalOptimMethod::LOCAL_OPTIM_SIGMA);

    emscripten::enum_<MarkerTypes>("MarkerTypes")
        .value("MARKER_CROSS", MarkerTypes::MARKER_CROSS)
        .value("MARKER_TILTED_CROSS", MarkerTypes::MARKER_TILTED_CROSS)
        .value("MARKER_STAR", MarkerTypes::MARKER_STAR)
        .value("MARKER_DIAMOND", MarkerTypes::MARKER_DIAMOND)
        .value("MARKER_SQUARE", MarkerTypes::MARKER_SQUARE)
        .value("MARKER_TRIANGLE_UP", MarkerTypes::MARKER_TRIANGLE_UP)
        .value("MARKER_TRIANGLE_DOWN", MarkerTypes::MARKER_TRIANGLE_DOWN);

    emscripten::enum_<MorphShapes>("MorphShapes")
        .value("MORPH_RECT", MorphShapes::MORPH_RECT)
        .value("MORPH_CROSS", MorphShapes::MORPH_CROSS)
        .value("MORPH_ELLIPSE", MorphShapes::MORPH_ELLIPSE)
        .value("MORPH_DIAMOND", MorphShapes::MORPH_DIAMOND);

    emscripten::enum_<MorphTypes>("MorphTypes")
        .value("MORPH_ERODE", MorphTypes::MORPH_ERODE)
        .value("MORPH_DILATE", MorphTypes::MORPH_DILATE)
        .value("MORPH_OPEN", MorphTypes::MORPH_OPEN)
        .value("MORPH_CLOSE", MorphTypes::MORPH_CLOSE)
        .value("MORPH_GRADIENT", MorphTypes::MORPH_GRADIENT)
        .value("MORPH_TOPHAT", MorphTypes::MORPH_TOPHAT)
        .value("MORPH_BLACKHAT", MorphTypes::MORPH_BLACKHAT)
        .value("MORPH_HITMISS", MorphTypes::MORPH_HITMISS);

    emscripten::enum_<NeighborSearchMethod>("NeighborSearchMethod")
        .value("NEIGH_FLANN_KNN", NeighborSearchMethod::NEIGH_FLANN_KNN)
        .value("NEIGH_GRID", NeighborSearchMethod::NEIGH_GRID)
        .value("NEIGH_FLANN_RADIUS", NeighborSearchMethod::NEIGH_FLANN_RADIUS);

    emscripten::enum_<NormTypes>("NormTypes")
        .value("NORM_INF", NormTypes::NORM_INF)
        .value("NORM_L1", NormTypes::NORM_L1)
        .value("NORM_L2", NormTypes::NORM_L2)
        .value("NORM_L2SQR", NormTypes::NORM_L2SQR)
        .value("NORM_HAMMING", NormTypes::NORM_HAMMING)
        .value("NORM_HAMMING2", NormTypes::NORM_HAMMING2)
        .value("NORM_TYPE_MASK", NormTypes::NORM_TYPE_MASK)
        .value("NORM_RELATIVE", NormTypes::NORM_RELATIVE)
        .value("NORM_MINMAX", NormTypes::NORM_MINMAX);

    emscripten::enum_<ORB::ScoreType>("ORB_ScoreType")
        .value("HARRIS_SCORE", ORB::ScoreType::HARRIS_SCORE)
        .value("FAST_SCORE", ORB::ScoreType::FAST_SCORE);

    emscripten::enum_<PCA::Flags>("PCA_Flags")
        .value("DATA_AS_ROW", PCA::Flags::DATA_AS_ROW)
        .value("DATA_AS_COL", PCA::Flags::DATA_AS_COL)
        .value("USE_AVG", PCA::Flags::USE_AVG);

    emscripten::enum_<Param>("Param")
        .value("INT", Param::INT)
        .value("BOOLEAN", Param::BOOLEAN)
        .value("REAL", Param::REAL)
        .value("STRING", Param::STRING)
        .value("MAT", Param::MAT)
        .value("MAT_VECTOR", Param::MAT_VECTOR)
        .value("ALGORITHM", Param::ALGORITHM)
        .value("FLOAT", Param::FLOAT)
        .value("UNSIGNED_INT", Param::UNSIGNED_INT)
        .value("UINT64", Param::UINT64)
        .value("UCHAR", Param::UCHAR)
        .value("SCALAR", Param::SCALAR);

    emscripten::enum_<PolishingMethod>("PolishingMethod")
        .value("NONE_POLISHER", PolishingMethod::NONE_POLISHER)
        .value("LSQ_POLISHER", PolishingMethod::LSQ_POLISHER)
        .value("MAGSAC", PolishingMethod::MAGSAC)
        .value("COV_POLISHER", PolishingMethod::COV_POLISHER);

    emscripten::enum_<QRCodeEncoder::CorrectionLevel>("QRCodeEncoder_CorrectionLevel")
        .value("CORRECT_LEVEL_L", QRCodeEncoder::CorrectionLevel::CORRECT_LEVEL_L)
        .value("CORRECT_LEVEL_M", QRCodeEncoder::CorrectionLevel::CORRECT_LEVEL_M)
        .value("CORRECT_LEVEL_Q", QRCodeEncoder::CorrectionLevel::CORRECT_LEVEL_Q)
        .value("CORRECT_LEVEL_H", QRCodeEncoder::CorrectionLevel::CORRECT_LEVEL_H);

    emscripten::enum_<QRCodeEncoder::ECIEncodings>("QRCodeEncoder_ECIEncodings")
        .value("ECI_SHIFT_JIS", QRCodeEncoder::ECIEncodings::ECI_SHIFT_JIS)
        .value("ECI_UTF8", QRCodeEncoder::ECIEncodings::ECI_UTF8);

    emscripten::enum_<QRCodeEncoder::EncodeMode>("QRCodeEncoder_EncodeMode")
        .value("MODE_AUTO", QRCodeEncoder::EncodeMode::MODE_AUTO)
        .value("MODE_NUMERIC", QRCodeEncoder::EncodeMode::MODE_NUMERIC)
        .value("MODE_ALPHANUMERIC", QRCodeEncoder::EncodeMode::MODE_ALPHANUMERIC)
        .value("MODE_BYTE", QRCodeEncoder::EncodeMode::MODE_BYTE)
        .value("MODE_ECI", QRCodeEncoder::EncodeMode::MODE_ECI)
        .value("MODE_KANJI", QRCodeEncoder::EncodeMode::MODE_KANJI)
        .value("MODE_STRUCTURED_APPEND", QRCodeEncoder::EncodeMode::MODE_STRUCTURED_APPEND);

    emscripten::enum_<QuatAssumeType>("QuatAssumeType")
        .value("QUAT_ASSUME_NOT_UNIT", QuatAssumeType::QUAT_ASSUME_NOT_UNIT)
        .value("QUAT_ASSUME_UNIT", QuatAssumeType::QUAT_ASSUME_UNIT);

    emscripten::enum_<QuatEnum::EulerAnglesType>("QuatEnum_EulerAnglesType")
        .value("INT_XYZ", QuatEnum::EulerAnglesType::INT_XYZ)
        .value("INT_XZY", QuatEnum::EulerAnglesType::INT_XZY)
        .value("INT_YXZ", QuatEnum::EulerAnglesType::INT_YXZ)
        .value("INT_YZX", QuatEnum::EulerAnglesType::INT_YZX)
        .value("INT_ZXY", QuatEnum::EulerAnglesType::INT_ZXY)
        .value("INT_ZYX", QuatEnum::EulerAnglesType::INT_ZYX)
        .value("INT_XYX", QuatEnum::EulerAnglesType::INT_XYX)
        .value("INT_XZX", QuatEnum::EulerAnglesType::INT_XZX)
        .value("INT_YXY", QuatEnum::EulerAnglesType::INT_YXY)
        .value("INT_YZY", QuatEnum::EulerAnglesType::INT_YZY)
        .value("INT_ZXZ", QuatEnum::EulerAnglesType::INT_ZXZ)
        .value("INT_ZYZ", QuatEnum::EulerAnglesType::INT_ZYZ)
        .value("EXT_XYZ", QuatEnum::EulerAnglesType::EXT_XYZ)
        .value("EXT_XZY", QuatEnum::EulerAnglesType::EXT_XZY)
        .value("EXT_YXZ", QuatEnum::EulerAnglesType::EXT_YXZ)
        .value("EXT_YZX", QuatEnum::EulerAnglesType::EXT_YZX)
        .value("EXT_ZXY", QuatEnum::EulerAnglesType::EXT_ZXY)
        .value("EXT_ZYX", QuatEnum::EulerAnglesType::EXT_ZYX)
        .value("EXT_XYX", QuatEnum::EulerAnglesType::EXT_XYX)
        .value("EXT_XZX", QuatEnum::EulerAnglesType::EXT_XZX)
        .value("EXT_YXY", QuatEnum::EulerAnglesType::EXT_YXY)
        .value("EXT_YZY", QuatEnum::EulerAnglesType::EXT_YZY)
        .value("EXT_ZXZ", QuatEnum::EulerAnglesType::EXT_ZXZ)
        .value("EXT_ZYZ", QuatEnum::EulerAnglesType::EXT_ZYZ)
        .value("EULER_ANGLES_MAX_VALUE", QuatEnum::EulerAnglesType::EULER_ANGLES_MAX_VALUE);

    emscripten::enum_<RectanglesIntersectTypes>("RectanglesIntersectTypes")
        .value("INTERSECT_NONE", RectanglesIntersectTypes::INTERSECT_NONE)
        .value("INTERSECT_PARTIAL", RectanglesIntersectTypes::INTERSECT_PARTIAL)
        .value("INTERSECT_FULL", RectanglesIntersectTypes::INTERSECT_FULL);

    emscripten::enum_<ReduceTypes>("ReduceTypes")
        .value("REDUCE_SUM", ReduceTypes::REDUCE_SUM)
        .value("REDUCE_AVG", ReduceTypes::REDUCE_AVG)
        .value("REDUCE_MAX", ReduceTypes::REDUCE_MAX)
        .value("REDUCE_MIN", ReduceTypes::REDUCE_MIN)
        .value("REDUCE_SUM2", ReduceTypes::REDUCE_SUM2);

    emscripten::enum_<RetrievalModes>("RetrievalModes")
        .value("RETR_EXTERNAL", RetrievalModes::RETR_EXTERNAL)
        .value("RETR_LIST", RetrievalModes::RETR_LIST)
        .value("RETR_CCOMP", RetrievalModes::RETR_CCOMP)
        .value("RETR_TREE", RetrievalModes::RETR_TREE)
        .value("RETR_FLOODFILL", RetrievalModes::RETR_FLOODFILL);

    emscripten::enum_<RobotWorldHandEyeCalibrationMethod>("RobotWorldHandEyeCalibrationMethod")
        .value("CALIB_ROBOT_WORLD_HAND_EYE_SHAH", RobotWorldHandEyeCalibrationMethod::CALIB_ROBOT_WORLD_HAND_EYE_SHAH)
        .value("CALIB_ROBOT_WORLD_HAND_EYE_LI", RobotWorldHandEyeCalibrationMethod::CALIB_ROBOT_WORLD_HAND_EYE_LI);

    emscripten::enum_<RotateFlags>("RotateFlags")
        .value("ROTATE_90_CLOCKWISE", RotateFlags::ROTATE_90_CLOCKWISE)
        .value("ROTATE_180", RotateFlags::ROTATE_180)
        .value("ROTATE_90_COUNTERCLOCKWISE", RotateFlags::ROTATE_90_COUNTERCLOCKWISE);

    emscripten::enum_<SVD::Flags>("SVD_Flags")
        .value("MODIFY_A", SVD::Flags::MODIFY_A)
        .value("NO_UV", SVD::Flags::NO_UV)
        .value("FULL_UV", SVD::Flags::FULL_UV);

    emscripten::enum_<SamplingMethod>("SamplingMethod")
        .value("SAMPLING_UNIFORM", SamplingMethod::SAMPLING_UNIFORM)
        .value("SAMPLING_PROGRESSIVE_NAPSAC", SamplingMethod::SAMPLING_PROGRESSIVE_NAPSAC)
        .value("SAMPLING_NAPSAC", SamplingMethod::SAMPLING_NAPSAC)
        .value("SAMPLING_PROSAC", SamplingMethod::SAMPLING_PROSAC);

    emscripten::enum_<ScoreMethod>("ScoreMethod")
        .value("SCORE_METHOD_RANSAC", ScoreMethod::SCORE_METHOD_RANSAC)
        .value("SCORE_METHOD_MSAC", ScoreMethod::SCORE_METHOD_MSAC)
        .value("SCORE_METHOD_MAGSAC", ScoreMethod::SCORE_METHOD_MAGSAC)
        .value("SCORE_METHOD_LMEDS", ScoreMethod::SCORE_METHOD_LMEDS);

    emscripten::enum_<SeamlessCloneFlags>("SeamlessCloneFlags")
        .value("NORMAL_CLONE", SeamlessCloneFlags::NORMAL_CLONE)
        .value("MIXED_CLONE", SeamlessCloneFlags::MIXED_CLONE)
        .value("MONOCHROME_TRANSFER", SeamlessCloneFlags::MONOCHROME_TRANSFER)
        .value("NORMAL_CLONE_WIDE", SeamlessCloneFlags::NORMAL_CLONE_WIDE)
        .value("MIXED_CLONE_WIDE", SeamlessCloneFlags::MIXED_CLONE_WIDE)
        .value("MONOCHROME_TRANSFER_WIDE", SeamlessCloneFlags::MONOCHROME_TRANSFER_WIDE);

    emscripten::enum_<ShapeMatchModes>("ShapeMatchModes")
        .value("CONTOURS_MATCH_I1", ShapeMatchModes::CONTOURS_MATCH_I1)
        .value("CONTOURS_MATCH_I2", ShapeMatchModes::CONTOURS_MATCH_I2)
        .value("CONTOURS_MATCH_I3", ShapeMatchModes::CONTOURS_MATCH_I3);

    emscripten::enum_<SolveLPResult>("SolveLPResult")
        .value("SOLVELP_LOST", SolveLPResult::SOLVELP_LOST)
        .value("SOLVELP_UNBOUNDED", SolveLPResult::SOLVELP_UNBOUNDED)
        .value("SOLVELP_UNFEASIBLE", SolveLPResult::SOLVELP_UNFEASIBLE)
        .value("SOLVELP_SINGLE", SolveLPResult::SOLVELP_SINGLE)
        .value("SOLVELP_MULTI", SolveLPResult::SOLVELP_MULTI);

    emscripten::enum_<SolvePnPMethod>("SolvePnPMethod")
        .value("SOLVEPNP_ITERATIVE", SolvePnPMethod::SOLVEPNP_ITERATIVE)
        .value("SOLVEPNP_EPNP", SolvePnPMethod::SOLVEPNP_EPNP)
        .value("SOLVEPNP_P3P", SolvePnPMethod::SOLVEPNP_P3P)
        .value("SOLVEPNP_DLS", SolvePnPMethod::SOLVEPNP_DLS)
        .value("SOLVEPNP_UPNP", SolvePnPMethod::SOLVEPNP_UPNP)
        .value("SOLVEPNP_AP3P", SolvePnPMethod::SOLVEPNP_AP3P)
        .value("SOLVEPNP_IPPE", SolvePnPMethod::SOLVEPNP_IPPE)
        .value("SOLVEPNP_IPPE_SQUARE", SolvePnPMethod::SOLVEPNP_IPPE_SQUARE)
        .value("SOLVEPNP_SQPNP", SolvePnPMethod::SOLVEPNP_SQPNP)
        .value("SOLVEPNP_MAX_COUNT", SolvePnPMethod::SOLVEPNP_MAX_COUNT);

    emscripten::enum_<SortFlags>("SortFlags")
        .value("SORT_EVERY_ROW", SortFlags::SORT_EVERY_ROW)
        .value("SORT_EVERY_COLUMN", SortFlags::SORT_EVERY_COLUMN)
        .value("SORT_ASCENDING", SortFlags::SORT_ASCENDING)
        .value("SORT_DESCENDING", SortFlags::SORT_DESCENDING);

    emscripten::enum_<SpecialFilter>("SpecialFilter")
        .value("FILTER_SCHARR", SpecialFilter::FILTER_SCHARR);

    emscripten::enum_<TemplateMatchModes>("TemplateMatchModes")
        .value("TM_SQDIFF", TemplateMatchModes::TM_SQDIFF)
        .value("TM_SQDIFF_NORMED", TemplateMatchModes::TM_SQDIFF_NORMED)
        .value("TM_CCORR", TemplateMatchModes::TM_CCORR)
        .value("TM_CCORR_NORMED", TemplateMatchModes::TM_CCORR_NORMED)
        .value("TM_CCOEFF", TemplateMatchModes::TM_CCOEFF)
        .value("TM_CCOEFF_NORMED", TemplateMatchModes::TM_CCOEFF_NORMED);

    emscripten::enum_<TermCriteria::Type>("TermCriteria_Type")
        .value("COUNT", TermCriteria::Type::COUNT)
        .value("MAX_ITER", TermCriteria::Type::MAX_ITER)
        .value("EPS", TermCriteria::Type::EPS);

    emscripten::enum_<ThresholdTypes>("ThresholdTypes")
        .value("THRESH_BINARY", ThresholdTypes::THRESH_BINARY)
        .value("THRESH_BINARY_INV", ThresholdTypes::THRESH_BINARY_INV)
        .value("THRESH_TRUNC", ThresholdTypes::THRESH_TRUNC)
        .value("THRESH_TOZERO", ThresholdTypes::THRESH_TOZERO)
        .value("THRESH_TOZERO_INV", ThresholdTypes::THRESH_TOZERO_INV)
        .value("THRESH_MASK", ThresholdTypes::THRESH_MASK)
        .value("THRESH_OTSU", ThresholdTypes::THRESH_OTSU)
        .value("THRESH_TRIANGLE", ThresholdTypes::THRESH_TRIANGLE)
        .value("THRESH_DRYRUN", ThresholdTypes::THRESH_DRYRUN);

    emscripten::enum_<UMatData::MemoryFlag>("UMatData_MemoryFlag")
        .value("COPY_ON_MAP", UMatData::MemoryFlag::COPY_ON_MAP)
        .value("HOST_COPY_OBSOLETE", UMatData::MemoryFlag::HOST_COPY_OBSOLETE)
        .value("DEVICE_COPY_OBSOLETE", UMatData::MemoryFlag::DEVICE_COPY_OBSOLETE)
        .value("TEMP_UMAT", UMatData::MemoryFlag::TEMP_UMAT)
        .value("TEMP_COPIED_UMAT", UMatData::MemoryFlag::TEMP_COPIED_UMAT)
        .value("USER_ALLOCATED", UMatData::MemoryFlag::USER_ALLOCATED)
        .value("DEVICE_MEM_MAPPED", UMatData::MemoryFlag::DEVICE_MEM_MAPPED)
        .value("ASYNC_CLEANUP", UMatData::MemoryFlag::ASYNC_CLEANUP);

    emscripten::enum_<UMatUsageFlags>("UMatUsageFlags")
        .value("USAGE_DEFAULT", UMatUsageFlags::USAGE_DEFAULT)
        .value("USAGE_ALLOCATE_HOST_MEMORY", UMatUsageFlags::USAGE_ALLOCATE_HOST_MEMORY)
        .value("USAGE_ALLOCATE_DEVICE_MEMORY", UMatUsageFlags::USAGE_ALLOCATE_DEVICE_MEMORY)
        .value("USAGE_ALLOCATE_SHARED_MEMORY", UMatUsageFlags::USAGE_ALLOCATE_SHARED_MEMORY)
        .value("__UMAT_USAGE_FLAGS_32BIT", UMatUsageFlags::__UMAT_USAGE_FLAGS_32BIT);

    emscripten::enum_<UndistortTypes>("UndistortTypes")
        .value("PROJ_SPHERICAL_ORTHO", UndistortTypes::PROJ_SPHERICAL_ORTHO)
        .value("PROJ_SPHERICAL_EQRECT", UndistortTypes::PROJ_SPHERICAL_EQRECT);

    emscripten::enum_<WarpPolarMode>("WarpPolarMode")
        .value("WARP_POLAR_LINEAR", WarpPolarMode::WARP_POLAR_LINEAR)
        .value("WARP_POLAR_LOG", WarpPolarMode::WARP_POLAR_LOG);

    emscripten::enum_<_InputArray::KindFlag>("_InputArray_KindFlag")
        .value("KIND_SHIFT", _InputArray::KindFlag::KIND_SHIFT)
        .value("FIXED_TYPE", _InputArray::KindFlag::FIXED_TYPE)
        .value("FIXED_SIZE", _InputArray::KindFlag::FIXED_SIZE)
        .value("KIND_MASK", _InputArray::KindFlag::KIND_MASK)
        .value("NONE", _InputArray::KindFlag::NONE)
        .value("MAT", _InputArray::KindFlag::MAT)
        .value("MATX", _InputArray::KindFlag::MATX)
        .value("STD_VECTOR", _InputArray::KindFlag::STD_VECTOR)
        .value("STD_VECTOR_VECTOR", _InputArray::KindFlag::STD_VECTOR_VECTOR)
        .value("STD_VECTOR_MAT", _InputArray::KindFlag::STD_VECTOR_MAT)
        .value("EXPR", _InputArray::KindFlag::EXPR)
        .value("OPENGL_BUFFER", _InputArray::KindFlag::OPENGL_BUFFER)
        .value("CUDA_HOST_MEM", _InputArray::KindFlag::CUDA_HOST_MEM)
        .value("CUDA_GPU_MAT", _InputArray::KindFlag::CUDA_GPU_MAT)
        .value("UMAT", _InputArray::KindFlag::UMAT)
        .value("STD_VECTOR_UMAT", _InputArray::KindFlag::STD_VECTOR_UMAT)
        .value("STD_BOOL_VECTOR", _InputArray::KindFlag::STD_BOOL_VECTOR)
        .value("STD_VECTOR_CUDA_GPU_MAT", _InputArray::KindFlag::STD_VECTOR_CUDA_GPU_MAT)
        .value("STD_ARRAY", _InputArray::KindFlag::STD_ARRAY)
        .value("STD_ARRAY_MAT", _InputArray::KindFlag::STD_ARRAY_MAT)
        .value("CUDA_GPU_MATND", _InputArray::KindFlag::CUDA_GPU_MATND);

    emscripten::enum_<_OutputArray::DepthMask>("_OutputArray_DepthMask")
        .value("DEPTH_MASK_8U", _OutputArray::DepthMask::DEPTH_MASK_8U)
        .value("DEPTH_MASK_8S", _OutputArray::DepthMask::DEPTH_MASK_8S)
        .value("DEPTH_MASK_16U", _OutputArray::DepthMask::DEPTH_MASK_16U)
        .value("DEPTH_MASK_16S", _OutputArray::DepthMask::DEPTH_MASK_16S)
        .value("DEPTH_MASK_32S", _OutputArray::DepthMask::DEPTH_MASK_32S)
        .value("DEPTH_MASK_32F", _OutputArray::DepthMask::DEPTH_MASK_32F)
        .value("DEPTH_MASK_64F", _OutputArray::DepthMask::DEPTH_MASK_64F)
        .value("DEPTH_MASK_16F", _OutputArray::DepthMask::DEPTH_MASK_16F)
        .value("DEPTH_MASK_ALL", _OutputArray::DepthMask::DEPTH_MASK_ALL)
        .value("DEPTH_MASK_ALL_BUT_8S", _OutputArray::DepthMask::DEPTH_MASK_ALL_BUT_8S)
        .value("DEPTH_MASK_ALL_16F", _OutputArray::DepthMask::DEPTH_MASK_ALL_16F)
        .value("DEPTH_MASK_FLT", _OutputArray::DepthMask::DEPTH_MASK_FLT);

    emscripten::enum_<Error::Code>("Error_Code")
        .value("StsOk", Error::Code::StsOk)
        .value("StsBackTrace", Error::Code::StsBackTrace)
        .value("StsError", Error::Code::StsError)
        .value("StsInternal", Error::Code::StsInternal)
        .value("StsNoMem", Error::Code::StsNoMem)
        .value("StsBadArg", Error::Code::StsBadArg)
        .value("StsBadFunc", Error::Code::StsBadFunc)
        .value("StsNoConv", Error::Code::StsNoConv)
        .value("StsAutoTrace", Error::Code::StsAutoTrace)
        .value("HeaderIsNull", Error::Code::HeaderIsNull)
        .value("BadImageSize", Error::Code::BadImageSize)
        .value("BadOffset", Error::Code::BadOffset)
        .value("BadDataPtr", Error::Code::BadDataPtr)
        .value("BadStep", Error::Code::BadStep)
        .value("BadModelOrChSeq", Error::Code::BadModelOrChSeq)
        .value("BadNumChannels", Error::Code::BadNumChannels)
        .value("BadNumChannel1U", Error::Code::BadNumChannel1U)
        .value("BadDepth", Error::Code::BadDepth)
        .value("BadAlphaChannel", Error::Code::BadAlphaChannel)
        .value("BadOrder", Error::Code::BadOrder)
        .value("BadOrigin", Error::Code::BadOrigin)
        .value("BadAlign", Error::Code::BadAlign)
        .value("BadCallBack", Error::Code::BadCallBack)
        .value("BadTileSize", Error::Code::BadTileSize)
        .value("BadCOI", Error::Code::BadCOI)
        .value("BadROISize", Error::Code::BadROISize)
        .value("MaskIsTiled", Error::Code::MaskIsTiled)
        .value("StsNullPtr", Error::Code::StsNullPtr)
        .value("StsVecLengthErr", Error::Code::StsVecLengthErr)
        .value("StsFilterStructContentErr", Error::Code::StsFilterStructContentErr)
        .value("StsKernelStructContentErr", Error::Code::StsKernelStructContentErr)
        .value("StsFilterOffsetErr", Error::Code::StsFilterOffsetErr)
        .value("StsBadSize", Error::Code::StsBadSize)
        .value("StsDivByZero", Error::Code::StsDivByZero)
        .value("StsInplaceNotSupported", Error::Code::StsInplaceNotSupported)
        .value("StsObjectNotFound", Error::Code::StsObjectNotFound)
        .value("StsUnmatchedFormats", Error::Code::StsUnmatchedFormats)
        .value("StsBadFlag", Error::Code::StsBadFlag)
        .value("StsBadPoint", Error::Code::StsBadPoint)
        .value("StsBadMask", Error::Code::StsBadMask)
        .value("StsUnmatchedSizes", Error::Code::StsUnmatchedSizes)
        .value("StsUnsupportedFormat", Error::Code::StsUnsupportedFormat)
        .value("StsOutOfRange", Error::Code::StsOutOfRange)
        .value("StsParseError", Error::Code::StsParseError)
        .value("StsNotImplemented", Error::Code::StsNotImplemented)
        .value("StsBadMemBlock", Error::Code::StsBadMemBlock)
        .value("StsAssert", Error::Code::StsAssert)
        .value("GpuNotSupported", Error::Code::GpuNotSupported)
        .value("GpuApiCallError", Error::Code::GpuApiCallError)
        .value("OpenGlNotSupported", Error::Code::OpenGlNotSupported)
        .value("OpenGlApiCallError", Error::Code::OpenGlApiCallError)
        .value("OpenCLApiCallError", Error::Code::OpenCLApiCallError)
        .value("OpenCLDoubleNotSupported", Error::Code::OpenCLDoubleNotSupported)
        .value("OpenCLInitError", Error::Code::OpenCLInitError)
        .value("OpenCLNoAMDBlasFft", Error::Code::OpenCLNoAMDBlasFft);

    emscripten::enum_<aruco::CornerRefineMethod>("aruco_CornerRefineMethod")
        .value("CORNER_REFINE_NONE", aruco::CornerRefineMethod::CORNER_REFINE_NONE)
        .value("CORNER_REFINE_SUBPIX", aruco::CornerRefineMethod::CORNER_REFINE_SUBPIX)
        .value("CORNER_REFINE_CONTOUR", aruco::CornerRefineMethod::CORNER_REFINE_CONTOUR)
        .value("CORNER_REFINE_APRILTAG", aruco::CornerRefineMethod::CORNER_REFINE_APRILTAG);

    emscripten::enum_<aruco::PredefinedDictionaryType>("aruco_PredefinedDictionaryType")
        .value("DICT_4X4_50", aruco::PredefinedDictionaryType::DICT_4X4_50)
        .value("DICT_4X4_100", aruco::PredefinedDictionaryType::DICT_4X4_100)
        .value("DICT_4X4_250", aruco::PredefinedDictionaryType::DICT_4X4_250)
        .value("DICT_4X4_1000", aruco::PredefinedDictionaryType::DICT_4X4_1000)
        .value("DICT_5X5_50", aruco::PredefinedDictionaryType::DICT_5X5_50)
        .value("DICT_5X5_100", aruco::PredefinedDictionaryType::DICT_5X5_100)
        .value("DICT_5X5_250", aruco::PredefinedDictionaryType::DICT_5X5_250)
        .value("DICT_5X5_1000", aruco::PredefinedDictionaryType::DICT_5X5_1000)
        .value("DICT_6X6_50", aruco::PredefinedDictionaryType::DICT_6X6_50)
        .value("DICT_6X6_100", aruco::PredefinedDictionaryType::DICT_6X6_100)
        .value("DICT_6X6_250", aruco::PredefinedDictionaryType::DICT_6X6_250)
        .value("DICT_6X6_1000", aruco::PredefinedDictionaryType::DICT_6X6_1000)
        .value("DICT_7X7_50", aruco::PredefinedDictionaryType::DICT_7X7_50)
        .value("DICT_7X7_100", aruco::PredefinedDictionaryType::DICT_7X7_100)
        .value("DICT_7X7_250", aruco::PredefinedDictionaryType::DICT_7X7_250)
        .value("DICT_7X7_1000", aruco::PredefinedDictionaryType::DICT_7X7_1000)
        .value("DICT_ARUCO_ORIGINAL", aruco::PredefinedDictionaryType::DICT_ARUCO_ORIGINAL)
        .value("DICT_APRILTAG_16h5", aruco::PredefinedDictionaryType::DICT_APRILTAG_16h5)
        .value("DICT_APRILTAG_25h9", aruco::PredefinedDictionaryType::DICT_APRILTAG_25h9)
        .value("DICT_APRILTAG_36h10", aruco::PredefinedDictionaryType::DICT_APRILTAG_36h10)
        .value("DICT_APRILTAG_36h11", aruco::PredefinedDictionaryType::DICT_APRILTAG_36h11)
        .value("DICT_ARUCO_MIP_36h12", aruco::PredefinedDictionaryType::DICT_ARUCO_MIP_36h12);

    emscripten::enum_<detail::TestOp>("detail_TestOp")
        .value("TEST_CUSTOM", detail::TestOp::TEST_CUSTOM)
        .value("TEST_EQ", detail::TestOp::TEST_EQ)
        .value("TEST_NE", detail::TestOp::TEST_NE)
        .value("TEST_LE", detail::TestOp::TEST_LE)
        .value("TEST_LT", detail::TestOp::TEST_LT)
        .value("TEST_GE", detail::TestOp::TEST_GE)
        .value("TEST_GT", detail::TestOp::TEST_GT);

    emscripten::enum_<detail::TrackerSamplerCSC::MODE>("detail_TrackerSamplerCSC_MODE")
        .value("MODE_INIT_POS", detail::TrackerSamplerCSC::MODE::MODE_INIT_POS)
        .value("MODE_INIT_NEG", detail::TrackerSamplerCSC::MODE::MODE_INIT_NEG)
        .value("MODE_TRACK_POS", detail::TrackerSamplerCSC::MODE::MODE_TRACK_POS)
        .value("MODE_TRACK_NEG", detail::TrackerSamplerCSC::MODE::MODE_TRACK_NEG)
        .value("MODE_DETECT", detail::TrackerSamplerCSC::MODE::MODE_DETECT);

    emscripten::enum_<dnn::Backend>("dnn_Backend")
        .value("DNN_BACKEND_DEFAULT", dnn::Backend::DNN_BACKEND_DEFAULT)
        .value("DNN_BACKEND_HALIDE", dnn::Backend::DNN_BACKEND_HALIDE)
        .value("DNN_BACKEND_INFERENCE_ENGINE", dnn::Backend::DNN_BACKEND_INFERENCE_ENGINE)
        .value("DNN_BACKEND_OPENCV", dnn::Backend::DNN_BACKEND_OPENCV)
        .value("DNN_BACKEND_VKCOM", dnn::Backend::DNN_BACKEND_VKCOM)
        .value("DNN_BACKEND_CUDA", dnn::Backend::DNN_BACKEND_CUDA)
        .value("DNN_BACKEND_WEBNN", dnn::Backend::DNN_BACKEND_WEBNN)
        .value("DNN_BACKEND_TIMVX", dnn::Backend::DNN_BACKEND_TIMVX)
        .value("DNN_BACKEND_CANN", dnn::Backend::DNN_BACKEND_CANN);

    emscripten::enum_<dnn::DataLayout>("dnn_DataLayout")
        .value("DNN_LAYOUT_UNKNOWN", dnn::DataLayout::DNN_LAYOUT_UNKNOWN)
        .value("DNN_LAYOUT_ND", dnn::DataLayout::DNN_LAYOUT_ND)
        .value("DNN_LAYOUT_NCHW", dnn::DataLayout::DNN_LAYOUT_NCHW)
        .value("DNN_LAYOUT_NCDHW", dnn::DataLayout::DNN_LAYOUT_NCDHW)
        .value("DNN_LAYOUT_NHWC", dnn::DataLayout::DNN_LAYOUT_NHWC)
        .value("DNN_LAYOUT_NDHWC", dnn::DataLayout::DNN_LAYOUT_NDHWC)
        .value("DNN_LAYOUT_PLANAR", dnn::DataLayout::DNN_LAYOUT_PLANAR);

    emscripten::enum_<dnn::ImagePaddingMode>("dnn_ImagePaddingMode")
        .value("DNN_PMODE_NULL", dnn::ImagePaddingMode::DNN_PMODE_NULL)
        .value("DNN_PMODE_CROP_CENTER", dnn::ImagePaddingMode::DNN_PMODE_CROP_CENTER)
        .value("DNN_PMODE_LETTERBOX", dnn::ImagePaddingMode::DNN_PMODE_LETTERBOX);

    emscripten::enum_<dnn::SoftNMSMethod>("dnn_SoftNMSMethod")
        .value("SOFTNMS_LINEAR", dnn::SoftNMSMethod::SOFTNMS_LINEAR)
        .value("SOFTNMS_GAUSSIAN", dnn::SoftNMSMethod::SOFTNMS_GAUSSIAN);

    emscripten::enum_<dnn::Target>("dnn_Target")
        .value("DNN_TARGET_CPU", dnn::Target::DNN_TARGET_CPU)
        .value("DNN_TARGET_OPENCL", dnn::Target::DNN_TARGET_OPENCL)
        .value("DNN_TARGET_OPENCL_FP16", dnn::Target::DNN_TARGET_OPENCL_FP16)
        .value("DNN_TARGET_MYRIAD", dnn::Target::DNN_TARGET_MYRIAD)
        .value("DNN_TARGET_VULKAN", dnn::Target::DNN_TARGET_VULKAN)
        .value("DNN_TARGET_FPGA", dnn::Target::DNN_TARGET_FPGA)
        .value("DNN_TARGET_CUDA", dnn::Target::DNN_TARGET_CUDA)
        .value("DNN_TARGET_CUDA_FP16", dnn::Target::DNN_TARGET_CUDA_FP16)
        .value("DNN_TARGET_HDDL", dnn::Target::DNN_TARGET_HDDL)
        .value("DNN_TARGET_NPU", dnn::Target::DNN_TARGET_NPU)
        .value("DNN_TARGET_CPU_FP16", dnn::Target::DNN_TARGET_CPU_FP16);

    emscripten::enum_<utils::logging::LogLevel>("utils_logging_LogLevel")
        .value("LOG_LEVEL_SILENT", utils::logging::LogLevel::LOG_LEVEL_SILENT)
        .value("LOG_LEVEL_FATAL", utils::logging::LogLevel::LOG_LEVEL_FATAL)
        .value("LOG_LEVEL_ERROR", utils::logging::LogLevel::LOG_LEVEL_ERROR)
        .value("LOG_LEVEL_WARNING", utils::logging::LogLevel::LOG_LEVEL_WARNING)
        .value("LOG_LEVEL_INFO", utils::logging::LogLevel::LOG_LEVEL_INFO)
        .value("LOG_LEVEL_DEBUG", utils::logging::LogLevel::LOG_LEVEL_DEBUG)
        .value("LOG_LEVEL_VERBOSE", utils::logging::LogLevel::LOG_LEVEL_VERBOSE)
        .value("ENUM_LOG_LEVEL_FORCE_INT", utils::logging::LogLevel::ENUM_LOG_LEVEL_FORCE_INT);

    constant("ACCESS_FAST", static_cast<long>(cv::ACCESS_FAST));

    constant("ACCESS_MASK", static_cast<long>(cv::ACCESS_MASK));

    constant("ACCESS_READ", static_cast<long>(cv::ACCESS_READ));

    constant("ACCESS_RW", static_cast<long>(cv::ACCESS_RW));

    constant("ACCESS_WRITE", static_cast<long>(cv::ACCESS_WRITE));

    constant("ADAPTIVE_THRESH_GAUSSIAN_C", static_cast<long>(cv::ADAPTIVE_THRESH_GAUSSIAN_C));

    constant("ADAPTIVE_THRESH_MEAN_C", static_cast<long>(cv::ADAPTIVE_THRESH_MEAN_C));

    constant("AKAZE_DESCRIPTOR_KAZE", static_cast<long>(cv::AKAZE::DESCRIPTOR_KAZE));

    constant("AKAZE_DESCRIPTOR_KAZE_UPRIGHT", static_cast<long>(cv::AKAZE::DESCRIPTOR_KAZE_UPRIGHT));

    constant("AKAZE_DESCRIPTOR_MLDB", static_cast<long>(cv::AKAZE::DESCRIPTOR_MLDB));

    constant("AKAZE_DESCRIPTOR_MLDB_UPRIGHT", static_cast<long>(cv::AKAZE::DESCRIPTOR_MLDB_UPRIGHT));

    constant("ALGO_HINT_ACCURATE", static_cast<long>(cv::ALGO_HINT_ACCURATE));

    constant("ALGO_HINT_APPROX", static_cast<long>(cv::ALGO_HINT_APPROX));

    constant("ALGO_HINT_DEFAULT", static_cast<long>(cv::ALGO_HINT_DEFAULT));

    constant("AgastFeatureDetector_AGAST_5_8", static_cast<long>(cv::AgastFeatureDetector::AGAST_5_8));

    constant("AgastFeatureDetector_AGAST_7_12d", static_cast<long>(cv::AgastFeatureDetector::AGAST_7_12d));

    constant("AgastFeatureDetector_AGAST_7_12s", static_cast<long>(cv::AgastFeatureDetector::AGAST_7_12s));

    constant("AgastFeatureDetector_NONMAX_SUPPRESSION", static_cast<long>(cv::AgastFeatureDetector::NONMAX_SUPPRESSION));

    constant("AgastFeatureDetector_OAST_9_16", static_cast<long>(cv::AgastFeatureDetector::OAST_9_16));

    constant("AgastFeatureDetector_THRESHOLD", static_cast<long>(cv::AgastFeatureDetector::THRESHOLD));

    constant("BORDER_CONSTANT", static_cast<long>(cv::BORDER_CONSTANT));

    constant("BORDER_DEFAULT", static_cast<long>(cv::BORDER_DEFAULT));

    constant("BORDER_ISOLATED", static_cast<long>(cv::BORDER_ISOLATED));

    constant("BORDER_REFLECT", static_cast<long>(cv::BORDER_REFLECT));

    constant("BORDER_REFLECT101", static_cast<long>(cv::BORDER_REFLECT101));

    constant("BORDER_REFLECT_101", static_cast<long>(cv::BORDER_REFLECT_101));

    constant("BORDER_REPLICATE", static_cast<long>(cv::BORDER_REPLICATE));

    constant("BORDER_TRANSPARENT", static_cast<long>(cv::BORDER_TRANSPARENT));

    constant("BORDER_WRAP", static_cast<long>(cv::BORDER_WRAP));

    constant("CALIB_CB_ACCURACY", static_cast<long>(cv::CALIB_CB_ACCURACY));

    constant("CALIB_CB_ADAPTIVE_THRESH", static_cast<long>(cv::CALIB_CB_ADAPTIVE_THRESH));

    constant("CALIB_CB_ASYMMETRIC_GRID", static_cast<long>(cv::CALIB_CB_ASYMMETRIC_GRID));

    constant("CALIB_CB_CLUSTERING", static_cast<long>(cv::CALIB_CB_CLUSTERING));

    constant("CALIB_CB_EXHAUSTIVE", static_cast<long>(cv::CALIB_CB_EXHAUSTIVE));

    constant("CALIB_CB_FAST_CHECK", static_cast<long>(cv::CALIB_CB_FAST_CHECK));

    constant("CALIB_CB_FILTER_QUADS", static_cast<long>(cv::CALIB_CB_FILTER_QUADS));

    constant("CALIB_CB_LARGER", static_cast<long>(cv::CALIB_CB_LARGER));

    constant("CALIB_CB_MARKER", static_cast<long>(cv::CALIB_CB_MARKER));

    constant("CALIB_CB_NORMALIZE_IMAGE", static_cast<long>(cv::CALIB_CB_NORMALIZE_IMAGE));

    constant("CALIB_CB_PLAIN", static_cast<long>(cv::CALIB_CB_PLAIN));

    constant("CALIB_CB_SYMMETRIC_GRID", static_cast<long>(cv::CALIB_CB_SYMMETRIC_GRID));

    constant("CALIB_DISABLE_SCHUR_COMPLEMENT", static_cast<long>(cv::CALIB_DISABLE_SCHUR_COMPLEMENT));

    constant("CALIB_FIX_ASPECT_RATIO", static_cast<long>(cv::CALIB_FIX_ASPECT_RATIO));

    constant("CALIB_FIX_FOCAL_LENGTH", static_cast<long>(cv::CALIB_FIX_FOCAL_LENGTH));

    constant("CALIB_FIX_INTRINSIC", static_cast<long>(cv::CALIB_FIX_INTRINSIC));

    constant("CALIB_FIX_K1", static_cast<long>(cv::CALIB_FIX_K1));

    constant("CALIB_FIX_K2", static_cast<long>(cv::CALIB_FIX_K2));

    constant("CALIB_FIX_K3", static_cast<long>(cv::CALIB_FIX_K3));

    constant("CALIB_FIX_K4", static_cast<long>(cv::CALIB_FIX_K4));

    constant("CALIB_FIX_K5", static_cast<long>(cv::CALIB_FIX_K5));

    constant("CALIB_FIX_K6", static_cast<long>(cv::CALIB_FIX_K6));

    constant("CALIB_FIX_PRINCIPAL_POINT", static_cast<long>(cv::CALIB_FIX_PRINCIPAL_POINT));

    constant("CALIB_FIX_S1_S2_S3_S4", static_cast<long>(cv::CALIB_FIX_S1_S2_S3_S4));

    constant("CALIB_FIX_TANGENT_DIST", static_cast<long>(cv::CALIB_FIX_TANGENT_DIST));

    constant("CALIB_FIX_TAUX_TAUY", static_cast<long>(cv::CALIB_FIX_TAUX_TAUY));

    constant("CALIB_HAND_EYE_ANDREFF", static_cast<long>(cv::CALIB_HAND_EYE_ANDREFF));

    constant("CALIB_HAND_EYE_DANIILIDIS", static_cast<long>(cv::CALIB_HAND_EYE_DANIILIDIS));

    constant("CALIB_HAND_EYE_HORAUD", static_cast<long>(cv::CALIB_HAND_EYE_HORAUD));

    constant("CALIB_HAND_EYE_PARK", static_cast<long>(cv::CALIB_HAND_EYE_PARK));

    constant("CALIB_HAND_EYE_TSAI", static_cast<long>(cv::CALIB_HAND_EYE_TSAI));

    constant("CALIB_NINTRINSIC", static_cast<long>(cv::CALIB_NINTRINSIC));

    constant("CALIB_RATIONAL_MODEL", static_cast<long>(cv::CALIB_RATIONAL_MODEL));

    constant("CALIB_ROBOT_WORLD_HAND_EYE_LI", static_cast<long>(cv::CALIB_ROBOT_WORLD_HAND_EYE_LI));

    constant("CALIB_ROBOT_WORLD_HAND_EYE_SHAH", static_cast<long>(cv::CALIB_ROBOT_WORLD_HAND_EYE_SHAH));

    constant("CALIB_SAME_FOCAL_LENGTH", static_cast<long>(cv::CALIB_SAME_FOCAL_LENGTH));

    constant("CALIB_THIN_PRISM_MODEL", static_cast<long>(cv::CALIB_THIN_PRISM_MODEL));

    constant("CALIB_TILTED_MODEL", static_cast<long>(cv::CALIB_TILTED_MODEL));

    constant("CALIB_USE_EXTRINSIC_GUESS", static_cast<long>(cv::CALIB_USE_EXTRINSIC_GUESS));

    constant("CALIB_USE_INTRINSIC_GUESS", static_cast<long>(cv::CALIB_USE_INTRINSIC_GUESS));

    constant("CALIB_USE_LU", static_cast<long>(cv::CALIB_USE_LU));

    constant("CALIB_USE_QR", static_cast<long>(cv::CALIB_USE_QR));

    constant("CALIB_ZERO_DISPARITY", static_cast<long>(cv::CALIB_ZERO_DISPARITY));

    constant("CALIB_ZERO_TANGENT_DIST", static_cast<long>(cv::CALIB_ZERO_TANGENT_DIST));

    constant("CASCADE_DO_CANNY_PRUNING", static_cast<long>(cv::CASCADE_DO_CANNY_PRUNING));

    constant("CASCADE_DO_ROUGH_SEARCH", static_cast<long>(cv::CASCADE_DO_ROUGH_SEARCH));

    constant("CASCADE_FIND_BIGGEST_OBJECT", static_cast<long>(cv::CASCADE_FIND_BIGGEST_OBJECT));

    constant("CASCADE_SCALE_IMAGE", static_cast<long>(cv::CASCADE_SCALE_IMAGE));

    constant("CCL_BBDT", static_cast<long>(cv::CCL_BBDT));

    constant("CCL_BOLELLI", static_cast<long>(cv::CCL_BOLELLI));

    constant("CCL_DEFAULT", static_cast<long>(cv::CCL_DEFAULT));

    constant("CCL_GRANA", static_cast<long>(cv::CCL_GRANA));

    constant("CCL_SAUF", static_cast<long>(cv::CCL_SAUF));

    constant("CCL_SPAGHETTI", static_cast<long>(cv::CCL_SPAGHETTI));

    constant("CCL_WU", static_cast<long>(cv::CCL_WU));

    constant("CC_STAT_AREA", static_cast<long>(cv::CC_STAT_AREA));

    constant("CC_STAT_HEIGHT", static_cast<long>(cv::CC_STAT_HEIGHT));

    constant("CC_STAT_LEFT", static_cast<long>(cv::CC_STAT_LEFT));

    constant("CC_STAT_MAX", static_cast<long>(cv::CC_STAT_MAX));

    constant("CC_STAT_TOP", static_cast<long>(cv::CC_STAT_TOP));

    constant("CC_STAT_WIDTH", static_cast<long>(cv::CC_STAT_WIDTH));

    constant("CHAIN_APPROX_NONE", static_cast<long>(cv::CHAIN_APPROX_NONE));

    constant("CHAIN_APPROX_SIMPLE", static_cast<long>(cv::CHAIN_APPROX_SIMPLE));

    constant("CHAIN_APPROX_TC89_KCOS", static_cast<long>(cv::CHAIN_APPROX_TC89_KCOS));

    constant("CHAIN_APPROX_TC89_L1", static_cast<long>(cv::CHAIN_APPROX_TC89_L1));

    constant("CMP_EQ", static_cast<long>(cv::CMP_EQ));

    constant("CMP_GE", static_cast<long>(cv::CMP_GE));

    constant("CMP_GT", static_cast<long>(cv::CMP_GT));

    constant("CMP_LE", static_cast<long>(cv::CMP_LE));

    constant("CMP_LT", static_cast<long>(cv::CMP_LT));

    constant("CMP_NE", static_cast<long>(cv::CMP_NE));

    constant("COLORMAP_AUTUMN", static_cast<long>(cv::COLORMAP_AUTUMN));

    constant("COLORMAP_BONE", static_cast<long>(cv::COLORMAP_BONE));

    constant("COLORMAP_CIVIDIS", static_cast<long>(cv::COLORMAP_CIVIDIS));

    constant("COLORMAP_COOL", static_cast<long>(cv::COLORMAP_COOL));

    constant("COLORMAP_DEEPGREEN", static_cast<long>(cv::COLORMAP_DEEPGREEN));

    constant("COLORMAP_HOT", static_cast<long>(cv::COLORMAP_HOT));

    constant("COLORMAP_HSV", static_cast<long>(cv::COLORMAP_HSV));

    constant("COLORMAP_INFERNO", static_cast<long>(cv::COLORMAP_INFERNO));

    constant("COLORMAP_JET", static_cast<long>(cv::COLORMAP_JET));

    constant("COLORMAP_MAGMA", static_cast<long>(cv::COLORMAP_MAGMA));

    constant("COLORMAP_OCEAN", static_cast<long>(cv::COLORMAP_OCEAN));

    constant("COLORMAP_PARULA", static_cast<long>(cv::COLORMAP_PARULA));

    constant("COLORMAP_PINK", static_cast<long>(cv::COLORMAP_PINK));

    constant("COLORMAP_PLASMA", static_cast<long>(cv::COLORMAP_PLASMA));

    constant("COLORMAP_RAINBOW", static_cast<long>(cv::COLORMAP_RAINBOW));

    constant("COLORMAP_SPRING", static_cast<long>(cv::COLORMAP_SPRING));

    constant("COLORMAP_SUMMER", static_cast<long>(cv::COLORMAP_SUMMER));

    constant("COLORMAP_TURBO", static_cast<long>(cv::COLORMAP_TURBO));

    constant("COLORMAP_TWILIGHT", static_cast<long>(cv::COLORMAP_TWILIGHT));

    constant("COLORMAP_TWILIGHT_SHIFTED", static_cast<long>(cv::COLORMAP_TWILIGHT_SHIFTED));

    constant("COLORMAP_VIRIDIS", static_cast<long>(cv::COLORMAP_VIRIDIS));

    constant("COLORMAP_WINTER", static_cast<long>(cv::COLORMAP_WINTER));

    constant("COLOR_BGR2BGR555", static_cast<long>(cv::COLOR_BGR2BGR555));

    constant("COLOR_BGR2BGR565", static_cast<long>(cv::COLOR_BGR2BGR565));

    constant("COLOR_BGR2BGRA", static_cast<long>(cv::COLOR_BGR2BGRA));

    constant("COLOR_BGR2GRAY", static_cast<long>(cv::COLOR_BGR2GRAY));

    constant("COLOR_BGR2HLS", static_cast<long>(cv::COLOR_BGR2HLS));

    constant("COLOR_BGR2HLS_FULL", static_cast<long>(cv::COLOR_BGR2HLS_FULL));

    constant("COLOR_BGR2HSV", static_cast<long>(cv::COLOR_BGR2HSV));

    constant("COLOR_BGR2HSV_FULL", static_cast<long>(cv::COLOR_BGR2HSV_FULL));

    constant("COLOR_BGR2Lab", static_cast<long>(cv::COLOR_BGR2Lab));

    constant("COLOR_BGR2Luv", static_cast<long>(cv::COLOR_BGR2Luv));

    constant("COLOR_BGR2RGB", static_cast<long>(cv::COLOR_BGR2RGB));

    constant("COLOR_BGR2RGBA", static_cast<long>(cv::COLOR_BGR2RGBA));

    constant("COLOR_BGR2XYZ", static_cast<long>(cv::COLOR_BGR2XYZ));

    constant("COLOR_BGR2YCrCb", static_cast<long>(cv::COLOR_BGR2YCrCb));

    constant("COLOR_BGR2YUV", static_cast<long>(cv::COLOR_BGR2YUV));

    constant("COLOR_BGR2YUV_I420", static_cast<long>(cv::COLOR_BGR2YUV_I420));

    constant("COLOR_BGR2YUV_IYUV", static_cast<long>(cv::COLOR_BGR2YUV_IYUV));

    constant("COLOR_BGR2YUV_UYNV", static_cast<long>(cv::COLOR_BGR2YUV_UYNV));

    constant("COLOR_BGR2YUV_UYVY", static_cast<long>(cv::COLOR_BGR2YUV_UYVY));

    constant("COLOR_BGR2YUV_Y422", static_cast<long>(cv::COLOR_BGR2YUV_Y422));

    constant("COLOR_BGR2YUV_YUNV", static_cast<long>(cv::COLOR_BGR2YUV_YUNV));

    constant("COLOR_BGR2YUV_YUY2", static_cast<long>(cv::COLOR_BGR2YUV_YUY2));

    constant("COLOR_BGR2YUV_YUYV", static_cast<long>(cv::COLOR_BGR2YUV_YUYV));

    constant("COLOR_BGR2YUV_YV12", static_cast<long>(cv::COLOR_BGR2YUV_YV12));

    constant("COLOR_BGR2YUV_YVYU", static_cast<long>(cv::COLOR_BGR2YUV_YVYU));

    constant("COLOR_BGR5552BGR", static_cast<long>(cv::COLOR_BGR5552BGR));

    constant("COLOR_BGR5552BGRA", static_cast<long>(cv::COLOR_BGR5552BGRA));

    constant("COLOR_BGR5552GRAY", static_cast<long>(cv::COLOR_BGR5552GRAY));

    constant("COLOR_BGR5552RGB", static_cast<long>(cv::COLOR_BGR5552RGB));

    constant("COLOR_BGR5552RGBA", static_cast<long>(cv::COLOR_BGR5552RGBA));

    constant("COLOR_BGR5652BGR", static_cast<long>(cv::COLOR_BGR5652BGR));

    constant("COLOR_BGR5652BGRA", static_cast<long>(cv::COLOR_BGR5652BGRA));

    constant("COLOR_BGR5652GRAY", static_cast<long>(cv::COLOR_BGR5652GRAY));

    constant("COLOR_BGR5652RGB", static_cast<long>(cv::COLOR_BGR5652RGB));

    constant("COLOR_BGR5652RGBA", static_cast<long>(cv::COLOR_BGR5652RGBA));

    constant("COLOR_BGRA2BGR", static_cast<long>(cv::COLOR_BGRA2BGR));

    constant("COLOR_BGRA2BGR555", static_cast<long>(cv::COLOR_BGRA2BGR555));

    constant("COLOR_BGRA2BGR565", static_cast<long>(cv::COLOR_BGRA2BGR565));

    constant("COLOR_BGRA2GRAY", static_cast<long>(cv::COLOR_BGRA2GRAY));

    constant("COLOR_BGRA2RGB", static_cast<long>(cv::COLOR_BGRA2RGB));

    constant("COLOR_BGRA2RGBA", static_cast<long>(cv::COLOR_BGRA2RGBA));

    constant("COLOR_BGRA2YUV_I420", static_cast<long>(cv::COLOR_BGRA2YUV_I420));

    constant("COLOR_BGRA2YUV_IYUV", static_cast<long>(cv::COLOR_BGRA2YUV_IYUV));

    constant("COLOR_BGRA2YUV_UYNV", static_cast<long>(cv::COLOR_BGRA2YUV_UYNV));

    constant("COLOR_BGRA2YUV_UYVY", static_cast<long>(cv::COLOR_BGRA2YUV_UYVY));

    constant("COLOR_BGRA2YUV_Y422", static_cast<long>(cv::COLOR_BGRA2YUV_Y422));

    constant("COLOR_BGRA2YUV_YUNV", static_cast<long>(cv::COLOR_BGRA2YUV_YUNV));

    constant("COLOR_BGRA2YUV_YUY2", static_cast<long>(cv::COLOR_BGRA2YUV_YUY2));

    constant("COLOR_BGRA2YUV_YUYV", static_cast<long>(cv::COLOR_BGRA2YUV_YUYV));

    constant("COLOR_BGRA2YUV_YV12", static_cast<long>(cv::COLOR_BGRA2YUV_YV12));

    constant("COLOR_BGRA2YUV_YVYU", static_cast<long>(cv::COLOR_BGRA2YUV_YVYU));

    constant("COLOR_BayerBG2BGR", static_cast<long>(cv::COLOR_BayerBG2BGR));

    constant("COLOR_BayerBG2BGRA", static_cast<long>(cv::COLOR_BayerBG2BGRA));

    constant("COLOR_BayerBG2BGR_EA", static_cast<long>(cv::COLOR_BayerBG2BGR_EA));

    constant("COLOR_BayerBG2BGR_VNG", static_cast<long>(cv::COLOR_BayerBG2BGR_VNG));

    constant("COLOR_BayerBG2GRAY", static_cast<long>(cv::COLOR_BayerBG2GRAY));

    constant("COLOR_BayerBG2RGB", static_cast<long>(cv::COLOR_BayerBG2RGB));

    constant("COLOR_BayerBG2RGBA", static_cast<long>(cv::COLOR_BayerBG2RGBA));

    constant("COLOR_BayerBG2RGB_EA", static_cast<long>(cv::COLOR_BayerBG2RGB_EA));

    constant("COLOR_BayerBG2RGB_VNG", static_cast<long>(cv::COLOR_BayerBG2RGB_VNG));

    constant("COLOR_BayerBGGR2BGR", static_cast<long>(cv::COLOR_BayerBGGR2BGR));

    constant("COLOR_BayerBGGR2BGRA", static_cast<long>(cv::COLOR_BayerBGGR2BGRA));

    constant("COLOR_BayerBGGR2BGR_EA", static_cast<long>(cv::COLOR_BayerBGGR2BGR_EA));

    constant("COLOR_BayerBGGR2BGR_VNG", static_cast<long>(cv::COLOR_BayerBGGR2BGR_VNG));

    constant("COLOR_BayerBGGR2GRAY", static_cast<long>(cv::COLOR_BayerBGGR2GRAY));

    constant("COLOR_BayerBGGR2RGB", static_cast<long>(cv::COLOR_BayerBGGR2RGB));

    constant("COLOR_BayerBGGR2RGBA", static_cast<long>(cv::COLOR_BayerBGGR2RGBA));

    constant("COLOR_BayerBGGR2RGB_EA", static_cast<long>(cv::COLOR_BayerBGGR2RGB_EA));

    constant("COLOR_BayerBGGR2RGB_VNG", static_cast<long>(cv::COLOR_BayerBGGR2RGB_VNG));

    constant("COLOR_BayerGB2BGR", static_cast<long>(cv::COLOR_BayerGB2BGR));

    constant("COLOR_BayerGB2BGRA", static_cast<long>(cv::COLOR_BayerGB2BGRA));

    constant("COLOR_BayerGB2BGR_EA", static_cast<long>(cv::COLOR_BayerGB2BGR_EA));

    constant("COLOR_BayerGB2BGR_VNG", static_cast<long>(cv::COLOR_BayerGB2BGR_VNG));

    constant("COLOR_BayerGB2GRAY", static_cast<long>(cv::COLOR_BayerGB2GRAY));

    constant("COLOR_BayerGB2RGB", static_cast<long>(cv::COLOR_BayerGB2RGB));

    constant("COLOR_BayerGB2RGBA", static_cast<long>(cv::COLOR_BayerGB2RGBA));

    constant("COLOR_BayerGB2RGB_EA", static_cast<long>(cv::COLOR_BayerGB2RGB_EA));

    constant("COLOR_BayerGB2RGB_VNG", static_cast<long>(cv::COLOR_BayerGB2RGB_VNG));

    constant("COLOR_BayerGBRG2BGR", static_cast<long>(cv::COLOR_BayerGBRG2BGR));

    constant("COLOR_BayerGBRG2BGRA", static_cast<long>(cv::COLOR_BayerGBRG2BGRA));

    constant("COLOR_BayerGBRG2BGR_EA", static_cast<long>(cv::COLOR_BayerGBRG2BGR_EA));

    constant("COLOR_BayerGBRG2BGR_VNG", static_cast<long>(cv::COLOR_BayerGBRG2BGR_VNG));

    constant("COLOR_BayerGBRG2GRAY", static_cast<long>(cv::COLOR_BayerGBRG2GRAY));

    constant("COLOR_BayerGBRG2RGB", static_cast<long>(cv::COLOR_BayerGBRG2RGB));

    constant("COLOR_BayerGBRG2RGBA", static_cast<long>(cv::COLOR_BayerGBRG2RGBA));

    constant("COLOR_BayerGBRG2RGB_EA", static_cast<long>(cv::COLOR_BayerGBRG2RGB_EA));

    constant("COLOR_BayerGBRG2RGB_VNG", static_cast<long>(cv::COLOR_BayerGBRG2RGB_VNG));

    constant("COLOR_BayerGR2BGR", static_cast<long>(cv::COLOR_BayerGR2BGR));

    constant("COLOR_BayerGR2BGRA", static_cast<long>(cv::COLOR_BayerGR2BGRA));

    constant("COLOR_BayerGR2BGR_EA", static_cast<long>(cv::COLOR_BayerGR2BGR_EA));

    constant("COLOR_BayerGR2BGR_VNG", static_cast<long>(cv::COLOR_BayerGR2BGR_VNG));

    constant("COLOR_BayerGR2GRAY", static_cast<long>(cv::COLOR_BayerGR2GRAY));

    constant("COLOR_BayerGR2RGB", static_cast<long>(cv::COLOR_BayerGR2RGB));

    constant("COLOR_BayerGR2RGBA", static_cast<long>(cv::COLOR_BayerGR2RGBA));

    constant("COLOR_BayerGR2RGB_EA", static_cast<long>(cv::COLOR_BayerGR2RGB_EA));

    constant("COLOR_BayerGR2RGB_VNG", static_cast<long>(cv::COLOR_BayerGR2RGB_VNG));

    constant("COLOR_BayerGRBG2BGR", static_cast<long>(cv::COLOR_BayerGRBG2BGR));

    constant("COLOR_BayerGRBG2BGRA", static_cast<long>(cv::COLOR_BayerGRBG2BGRA));

    constant("COLOR_BayerGRBG2BGR_EA", static_cast<long>(cv::COLOR_BayerGRBG2BGR_EA));

    constant("COLOR_BayerGRBG2BGR_VNG", static_cast<long>(cv::COLOR_BayerGRBG2BGR_VNG));

    constant("COLOR_BayerGRBG2GRAY", static_cast<long>(cv::COLOR_BayerGRBG2GRAY));

    constant("COLOR_BayerGRBG2RGB", static_cast<long>(cv::COLOR_BayerGRBG2RGB));

    constant("COLOR_BayerGRBG2RGBA", static_cast<long>(cv::COLOR_BayerGRBG2RGBA));

    constant("COLOR_BayerGRBG2RGB_EA", static_cast<long>(cv::COLOR_BayerGRBG2RGB_EA));

    constant("COLOR_BayerGRBG2RGB_VNG", static_cast<long>(cv::COLOR_BayerGRBG2RGB_VNG));

    constant("COLOR_BayerRG2BGR", static_cast<long>(cv::COLOR_BayerRG2BGR));

    constant("COLOR_BayerRG2BGRA", static_cast<long>(cv::COLOR_BayerRG2BGRA));

    constant("COLOR_BayerRG2BGR_EA", static_cast<long>(cv::COLOR_BayerRG2BGR_EA));

    constant("COLOR_BayerRG2BGR_VNG", static_cast<long>(cv::COLOR_BayerRG2BGR_VNG));

    constant("COLOR_BayerRG2GRAY", static_cast<long>(cv::COLOR_BayerRG2GRAY));

    constant("COLOR_BayerRG2RGB", static_cast<long>(cv::COLOR_BayerRG2RGB));

    constant("COLOR_BayerRG2RGBA", static_cast<long>(cv::COLOR_BayerRG2RGBA));

    constant("COLOR_BayerRG2RGB_EA", static_cast<long>(cv::COLOR_BayerRG2RGB_EA));

    constant("COLOR_BayerRG2RGB_VNG", static_cast<long>(cv::COLOR_BayerRG2RGB_VNG));

    constant("COLOR_BayerRGGB2BGR", static_cast<long>(cv::COLOR_BayerRGGB2BGR));

    constant("COLOR_BayerRGGB2BGRA", static_cast<long>(cv::COLOR_BayerRGGB2BGRA));

    constant("COLOR_BayerRGGB2BGR_EA", static_cast<long>(cv::COLOR_BayerRGGB2BGR_EA));

    constant("COLOR_BayerRGGB2BGR_VNG", static_cast<long>(cv::COLOR_BayerRGGB2BGR_VNG));

    constant("COLOR_BayerRGGB2GRAY", static_cast<long>(cv::COLOR_BayerRGGB2GRAY));

    constant("COLOR_BayerRGGB2RGB", static_cast<long>(cv::COLOR_BayerRGGB2RGB));

    constant("COLOR_BayerRGGB2RGBA", static_cast<long>(cv::COLOR_BayerRGGB2RGBA));

    constant("COLOR_BayerRGGB2RGB_EA", static_cast<long>(cv::COLOR_BayerRGGB2RGB_EA));

    constant("COLOR_BayerRGGB2RGB_VNG", static_cast<long>(cv::COLOR_BayerRGGB2RGB_VNG));

    constant("COLOR_COLORCVT_MAX", static_cast<long>(cv::COLOR_COLORCVT_MAX));

    constant("COLOR_GRAY2BGR", static_cast<long>(cv::COLOR_GRAY2BGR));

    constant("COLOR_GRAY2BGR555", static_cast<long>(cv::COLOR_GRAY2BGR555));

    constant("COLOR_GRAY2BGR565", static_cast<long>(cv::COLOR_GRAY2BGR565));

    constant("COLOR_GRAY2BGRA", static_cast<long>(cv::COLOR_GRAY2BGRA));

    constant("COLOR_GRAY2RGB", static_cast<long>(cv::COLOR_GRAY2RGB));

    constant("COLOR_GRAY2RGBA", static_cast<long>(cv::COLOR_GRAY2RGBA));

    constant("COLOR_HLS2BGR", static_cast<long>(cv::COLOR_HLS2BGR));

    constant("COLOR_HLS2BGR_FULL", static_cast<long>(cv::COLOR_HLS2BGR_FULL));

    constant("COLOR_HLS2RGB", static_cast<long>(cv::COLOR_HLS2RGB));

    constant("COLOR_HLS2RGB_FULL", static_cast<long>(cv::COLOR_HLS2RGB_FULL));

    constant("COLOR_HSV2BGR", static_cast<long>(cv::COLOR_HSV2BGR));

    constant("COLOR_HSV2BGR_FULL", static_cast<long>(cv::COLOR_HSV2BGR_FULL));

    constant("COLOR_HSV2RGB", static_cast<long>(cv::COLOR_HSV2RGB));

    constant("COLOR_HSV2RGB_FULL", static_cast<long>(cv::COLOR_HSV2RGB_FULL));

    constant("COLOR_LBGR2Lab", static_cast<long>(cv::COLOR_LBGR2Lab));

    constant("COLOR_LBGR2Luv", static_cast<long>(cv::COLOR_LBGR2Luv));

    constant("COLOR_LRGB2Lab", static_cast<long>(cv::COLOR_LRGB2Lab));

    constant("COLOR_LRGB2Luv", static_cast<long>(cv::COLOR_LRGB2Luv));

    constant("COLOR_Lab2BGR", static_cast<long>(cv::COLOR_Lab2BGR));

    constant("COLOR_Lab2LBGR", static_cast<long>(cv::COLOR_Lab2LBGR));

    constant("COLOR_Lab2LRGB", static_cast<long>(cv::COLOR_Lab2LRGB));

    constant("COLOR_Lab2RGB", static_cast<long>(cv::COLOR_Lab2RGB));

    constant("COLOR_Luv2BGR", static_cast<long>(cv::COLOR_Luv2BGR));

    constant("COLOR_Luv2LBGR", static_cast<long>(cv::COLOR_Luv2LBGR));

    constant("COLOR_Luv2LRGB", static_cast<long>(cv::COLOR_Luv2LRGB));

    constant("COLOR_Luv2RGB", static_cast<long>(cv::COLOR_Luv2RGB));

    constant("COLOR_RGB2BGR", static_cast<long>(cv::COLOR_RGB2BGR));

    constant("COLOR_RGB2BGR555", static_cast<long>(cv::COLOR_RGB2BGR555));

    constant("COLOR_RGB2BGR565", static_cast<long>(cv::COLOR_RGB2BGR565));

    constant("COLOR_RGB2BGRA", static_cast<long>(cv::COLOR_RGB2BGRA));

    constant("COLOR_RGB2GRAY", static_cast<long>(cv::COLOR_RGB2GRAY));

    constant("COLOR_RGB2HLS", static_cast<long>(cv::COLOR_RGB2HLS));

    constant("COLOR_RGB2HLS_FULL", static_cast<long>(cv::COLOR_RGB2HLS_FULL));

    constant("COLOR_RGB2HSV", static_cast<long>(cv::COLOR_RGB2HSV));

    constant("COLOR_RGB2HSV_FULL", static_cast<long>(cv::COLOR_RGB2HSV_FULL));

    constant("COLOR_RGB2Lab", static_cast<long>(cv::COLOR_RGB2Lab));

    constant("COLOR_RGB2Luv", static_cast<long>(cv::COLOR_RGB2Luv));

    constant("COLOR_RGB2RGBA", static_cast<long>(cv::COLOR_RGB2RGBA));

    constant("COLOR_RGB2XYZ", static_cast<long>(cv::COLOR_RGB2XYZ));

    constant("COLOR_RGB2YCrCb", static_cast<long>(cv::COLOR_RGB2YCrCb));

    constant("COLOR_RGB2YUV", static_cast<long>(cv::COLOR_RGB2YUV));

    constant("COLOR_RGB2YUV_I420", static_cast<long>(cv::COLOR_RGB2YUV_I420));

    constant("COLOR_RGB2YUV_IYUV", static_cast<long>(cv::COLOR_RGB2YUV_IYUV));

    constant("COLOR_RGB2YUV_UYNV", static_cast<long>(cv::COLOR_RGB2YUV_UYNV));

    constant("COLOR_RGB2YUV_UYVY", static_cast<long>(cv::COLOR_RGB2YUV_UYVY));

    constant("COLOR_RGB2YUV_Y422", static_cast<long>(cv::COLOR_RGB2YUV_Y422));

    constant("COLOR_RGB2YUV_YUNV", static_cast<long>(cv::COLOR_RGB2YUV_YUNV));

    constant("COLOR_RGB2YUV_YUY2", static_cast<long>(cv::COLOR_RGB2YUV_YUY2));

    constant("COLOR_RGB2YUV_YUYV", static_cast<long>(cv::COLOR_RGB2YUV_YUYV));

    constant("COLOR_RGB2YUV_YV12", static_cast<long>(cv::COLOR_RGB2YUV_YV12));

    constant("COLOR_RGB2YUV_YVYU", static_cast<long>(cv::COLOR_RGB2YUV_YVYU));

    constant("COLOR_RGBA2BGR", static_cast<long>(cv::COLOR_RGBA2BGR));

    constant("COLOR_RGBA2BGR555", static_cast<long>(cv::COLOR_RGBA2BGR555));

    constant("COLOR_RGBA2BGR565", static_cast<long>(cv::COLOR_RGBA2BGR565));

    constant("COLOR_RGBA2BGRA", static_cast<long>(cv::COLOR_RGBA2BGRA));

    constant("COLOR_RGBA2GRAY", static_cast<long>(cv::COLOR_RGBA2GRAY));

    constant("COLOR_RGBA2RGB", static_cast<long>(cv::COLOR_RGBA2RGB));

    constant("COLOR_RGBA2YUV_I420", static_cast<long>(cv::COLOR_RGBA2YUV_I420));

    constant("COLOR_RGBA2YUV_IYUV", static_cast<long>(cv::COLOR_RGBA2YUV_IYUV));

    constant("COLOR_RGBA2YUV_UYNV", static_cast<long>(cv::COLOR_RGBA2YUV_UYNV));

    constant("COLOR_RGBA2YUV_UYVY", static_cast<long>(cv::COLOR_RGBA2YUV_UYVY));

    constant("COLOR_RGBA2YUV_Y422", static_cast<long>(cv::COLOR_RGBA2YUV_Y422));

    constant("COLOR_RGBA2YUV_YUNV", static_cast<long>(cv::COLOR_RGBA2YUV_YUNV));

    constant("COLOR_RGBA2YUV_YUY2", static_cast<long>(cv::COLOR_RGBA2YUV_YUY2));

    constant("COLOR_RGBA2YUV_YUYV", static_cast<long>(cv::COLOR_RGBA2YUV_YUYV));

    constant("COLOR_RGBA2YUV_YV12", static_cast<long>(cv::COLOR_RGBA2YUV_YV12));

    constant("COLOR_RGBA2YUV_YVYU", static_cast<long>(cv::COLOR_RGBA2YUV_YVYU));

    constant("COLOR_RGBA2mRGBA", static_cast<long>(cv::COLOR_RGBA2mRGBA));

    constant("COLOR_XYZ2BGR", static_cast<long>(cv::COLOR_XYZ2BGR));

    constant("COLOR_XYZ2RGB", static_cast<long>(cv::COLOR_XYZ2RGB));

    constant("COLOR_YCrCb2BGR", static_cast<long>(cv::COLOR_YCrCb2BGR));

    constant("COLOR_YCrCb2RGB", static_cast<long>(cv::COLOR_YCrCb2RGB));

    constant("COLOR_YUV2BGR", static_cast<long>(cv::COLOR_YUV2BGR));

    constant("COLOR_YUV2BGRA_I420", static_cast<long>(cv::COLOR_YUV2BGRA_I420));

    constant("COLOR_YUV2BGRA_IYUV", static_cast<long>(cv::COLOR_YUV2BGRA_IYUV));

    constant("COLOR_YUV2BGRA_NV12", static_cast<long>(cv::COLOR_YUV2BGRA_NV12));

    constant("COLOR_YUV2BGRA_NV21", static_cast<long>(cv::COLOR_YUV2BGRA_NV21));

    constant("COLOR_YUV2BGRA_UYNV", static_cast<long>(cv::COLOR_YUV2BGRA_UYNV));

    constant("COLOR_YUV2BGRA_UYVY", static_cast<long>(cv::COLOR_YUV2BGRA_UYVY));

    constant("COLOR_YUV2BGRA_Y422", static_cast<long>(cv::COLOR_YUV2BGRA_Y422));

    constant("COLOR_YUV2BGRA_YUNV", static_cast<long>(cv::COLOR_YUV2BGRA_YUNV));

    constant("COLOR_YUV2BGRA_YUY2", static_cast<long>(cv::COLOR_YUV2BGRA_YUY2));

    constant("COLOR_YUV2BGRA_YUYV", static_cast<long>(cv::COLOR_YUV2BGRA_YUYV));

    constant("COLOR_YUV2BGRA_YV12", static_cast<long>(cv::COLOR_YUV2BGRA_YV12));

    constant("COLOR_YUV2BGRA_YVYU", static_cast<long>(cv::COLOR_YUV2BGRA_YVYU));

    constant("COLOR_YUV2BGR_I420", static_cast<long>(cv::COLOR_YUV2BGR_I420));

    constant("COLOR_YUV2BGR_IYUV", static_cast<long>(cv::COLOR_YUV2BGR_IYUV));

    constant("COLOR_YUV2BGR_NV12", static_cast<long>(cv::COLOR_YUV2BGR_NV12));

    constant("COLOR_YUV2BGR_NV21", static_cast<long>(cv::COLOR_YUV2BGR_NV21));

    constant("COLOR_YUV2BGR_UYNV", static_cast<long>(cv::COLOR_YUV2BGR_UYNV));

    constant("COLOR_YUV2BGR_UYVY", static_cast<long>(cv::COLOR_YUV2BGR_UYVY));

    constant("COLOR_YUV2BGR_Y422", static_cast<long>(cv::COLOR_YUV2BGR_Y422));

    constant("COLOR_YUV2BGR_YUNV", static_cast<long>(cv::COLOR_YUV2BGR_YUNV));

    constant("COLOR_YUV2BGR_YUY2", static_cast<long>(cv::COLOR_YUV2BGR_YUY2));

    constant("COLOR_YUV2BGR_YUYV", static_cast<long>(cv::COLOR_YUV2BGR_YUYV));

    constant("COLOR_YUV2BGR_YV12", static_cast<long>(cv::COLOR_YUV2BGR_YV12));

    constant("COLOR_YUV2BGR_YVYU", static_cast<long>(cv::COLOR_YUV2BGR_YVYU));

    constant("COLOR_YUV2GRAY_420", static_cast<long>(cv::COLOR_YUV2GRAY_420));

    constant("COLOR_YUV2GRAY_I420", static_cast<long>(cv::COLOR_YUV2GRAY_I420));

    constant("COLOR_YUV2GRAY_IYUV", static_cast<long>(cv::COLOR_YUV2GRAY_IYUV));

    constant("COLOR_YUV2GRAY_NV12", static_cast<long>(cv::COLOR_YUV2GRAY_NV12));

    constant("COLOR_YUV2GRAY_NV21", static_cast<long>(cv::COLOR_YUV2GRAY_NV21));

    constant("COLOR_YUV2GRAY_UYNV", static_cast<long>(cv::COLOR_YUV2GRAY_UYNV));

    constant("COLOR_YUV2GRAY_UYVY", static_cast<long>(cv::COLOR_YUV2GRAY_UYVY));

    constant("COLOR_YUV2GRAY_Y422", static_cast<long>(cv::COLOR_YUV2GRAY_Y422));

    constant("COLOR_YUV2GRAY_YUNV", static_cast<long>(cv::COLOR_YUV2GRAY_YUNV));

    constant("COLOR_YUV2GRAY_YUY2", static_cast<long>(cv::COLOR_YUV2GRAY_YUY2));

    constant("COLOR_YUV2GRAY_YUYV", static_cast<long>(cv::COLOR_YUV2GRAY_YUYV));

    constant("COLOR_YUV2GRAY_YV12", static_cast<long>(cv::COLOR_YUV2GRAY_YV12));

    constant("COLOR_YUV2GRAY_YVYU", static_cast<long>(cv::COLOR_YUV2GRAY_YVYU));

    constant("COLOR_YUV2RGB", static_cast<long>(cv::COLOR_YUV2RGB));

    constant("COLOR_YUV2RGBA_I420", static_cast<long>(cv::COLOR_YUV2RGBA_I420));

    constant("COLOR_YUV2RGBA_IYUV", static_cast<long>(cv::COLOR_YUV2RGBA_IYUV));

    constant("COLOR_YUV2RGBA_NV12", static_cast<long>(cv::COLOR_YUV2RGBA_NV12));

    constant("COLOR_YUV2RGBA_NV21", static_cast<long>(cv::COLOR_YUV2RGBA_NV21));

    constant("COLOR_YUV2RGBA_UYNV", static_cast<long>(cv::COLOR_YUV2RGBA_UYNV));

    constant("COLOR_YUV2RGBA_UYVY", static_cast<long>(cv::COLOR_YUV2RGBA_UYVY));

    constant("COLOR_YUV2RGBA_Y422", static_cast<long>(cv::COLOR_YUV2RGBA_Y422));

    constant("COLOR_YUV2RGBA_YUNV", static_cast<long>(cv::COLOR_YUV2RGBA_YUNV));

    constant("COLOR_YUV2RGBA_YUY2", static_cast<long>(cv::COLOR_YUV2RGBA_YUY2));

    constant("COLOR_YUV2RGBA_YUYV", static_cast<long>(cv::COLOR_YUV2RGBA_YUYV));

    constant("COLOR_YUV2RGBA_YV12", static_cast<long>(cv::COLOR_YUV2RGBA_YV12));

    constant("COLOR_YUV2RGBA_YVYU", static_cast<long>(cv::COLOR_YUV2RGBA_YVYU));

    constant("COLOR_YUV2RGB_I420", static_cast<long>(cv::COLOR_YUV2RGB_I420));

    constant("COLOR_YUV2RGB_IYUV", static_cast<long>(cv::COLOR_YUV2RGB_IYUV));

    constant("COLOR_YUV2RGB_NV12", static_cast<long>(cv::COLOR_YUV2RGB_NV12));

    constant("COLOR_YUV2RGB_NV21", static_cast<long>(cv::COLOR_YUV2RGB_NV21));

    constant("COLOR_YUV2RGB_UYNV", static_cast<long>(cv::COLOR_YUV2RGB_UYNV));

    constant("COLOR_YUV2RGB_UYVY", static_cast<long>(cv::COLOR_YUV2RGB_UYVY));

    constant("COLOR_YUV2RGB_Y422", static_cast<long>(cv::COLOR_YUV2RGB_Y422));

    constant("COLOR_YUV2RGB_YUNV", static_cast<long>(cv::COLOR_YUV2RGB_YUNV));

    constant("COLOR_YUV2RGB_YUY2", static_cast<long>(cv::COLOR_YUV2RGB_YUY2));

    constant("COLOR_YUV2RGB_YUYV", static_cast<long>(cv::COLOR_YUV2RGB_YUYV));

    constant("COLOR_YUV2RGB_YV12", static_cast<long>(cv::COLOR_YUV2RGB_YV12));

    constant("COLOR_YUV2RGB_YVYU", static_cast<long>(cv::COLOR_YUV2RGB_YVYU));

    constant("COLOR_YUV420p2BGR", static_cast<long>(cv::COLOR_YUV420p2BGR));

    constant("COLOR_YUV420p2BGRA", static_cast<long>(cv::COLOR_YUV420p2BGRA));

    constant("COLOR_YUV420p2GRAY", static_cast<long>(cv::COLOR_YUV420p2GRAY));

    constant("COLOR_YUV420p2RGB", static_cast<long>(cv::COLOR_YUV420p2RGB));

    constant("COLOR_YUV420p2RGBA", static_cast<long>(cv::COLOR_YUV420p2RGBA));

    constant("COLOR_YUV420sp2BGR", static_cast<long>(cv::COLOR_YUV420sp2BGR));

    constant("COLOR_YUV420sp2BGRA", static_cast<long>(cv::COLOR_YUV420sp2BGRA));

    constant("COLOR_YUV420sp2GRAY", static_cast<long>(cv::COLOR_YUV420sp2GRAY));

    constant("COLOR_YUV420sp2RGB", static_cast<long>(cv::COLOR_YUV420sp2RGB));

    constant("COLOR_YUV420sp2RGBA", static_cast<long>(cv::COLOR_YUV420sp2RGBA));

    constant("COLOR_mRGBA2RGBA", static_cast<long>(cv::COLOR_mRGBA2RGBA));

    constant("CONTOURS_MATCH_I1", static_cast<long>(cv::CONTOURS_MATCH_I1));

    constant("CONTOURS_MATCH_I2", static_cast<long>(cv::CONTOURS_MATCH_I2));

    constant("CONTOURS_MATCH_I3", static_cast<long>(cv::CONTOURS_MATCH_I3));

    constant("COVAR_COLS", static_cast<long>(cv::COVAR_COLS));

    constant("COVAR_NORMAL", static_cast<long>(cv::COVAR_NORMAL));

    constant("COVAR_ROWS", static_cast<long>(cv::COVAR_ROWS));

    constant("COVAR_SCALE", static_cast<long>(cv::COVAR_SCALE));

    constant("COVAR_SCRAMBLED", static_cast<long>(cv::COVAR_SCRAMBLED));

    constant("COVAR_USE_AVG", static_cast<long>(cv::COVAR_USE_AVG));

    constant("COV_POLISHER", static_cast<long>(cv::COV_POLISHER));

    constant("CirclesGridFinderParameters_ASYMMETRIC_GRID", static_cast<long>(cv::CirclesGridFinderParameters::ASYMMETRIC_GRID));

    constant("CirclesGridFinderParameters_SYMMETRIC_GRID", static_cast<long>(cv::CirclesGridFinderParameters::SYMMETRIC_GRID));

    constant("DCT_INVERSE", static_cast<long>(cv::DCT_INVERSE));

    constant("DCT_ROWS", static_cast<long>(cv::DCT_ROWS));

    constant("DECOMP_CHOLESKY", static_cast<long>(cv::DECOMP_CHOLESKY));

    constant("DECOMP_EIG", static_cast<long>(cv::DECOMP_EIG));

    constant("DECOMP_LU", static_cast<long>(cv::DECOMP_LU));

    constant("DECOMP_NORMAL", static_cast<long>(cv::DECOMP_NORMAL));

    constant("DECOMP_QR", static_cast<long>(cv::DECOMP_QR));

    constant("DECOMP_SVD", static_cast<long>(cv::DECOMP_SVD));

    constant("DFT_COMPLEX_INPUT", static_cast<long>(cv::DFT_COMPLEX_INPUT));

    constant("DFT_COMPLEX_OUTPUT", static_cast<long>(cv::DFT_COMPLEX_OUTPUT));

    constant("DFT_INVERSE", static_cast<long>(cv::DFT_INVERSE));

    constant("DFT_REAL_OUTPUT", static_cast<long>(cv::DFT_REAL_OUTPUT));

    constant("DFT_ROWS", static_cast<long>(cv::DFT_ROWS));

    constant("DFT_SCALE", static_cast<long>(cv::DFT_SCALE));

    constant("DISOpticalFlow_PRESET_FAST", static_cast<long>(cv::DISOpticalFlow::PRESET_FAST));

    constant("DISOpticalFlow_PRESET_MEDIUM", static_cast<long>(cv::DISOpticalFlow::PRESET_MEDIUM));

    constant("DISOpticalFlow_PRESET_ULTRAFAST", static_cast<long>(cv::DISOpticalFlow::PRESET_ULTRAFAST));

    constant("DIST_C", static_cast<long>(cv::DIST_C));

    constant("DIST_FAIR", static_cast<long>(cv::DIST_FAIR));

    constant("DIST_HUBER", static_cast<long>(cv::DIST_HUBER));

    constant("DIST_L1", static_cast<long>(cv::DIST_L1));

    constant("DIST_L12", static_cast<long>(cv::DIST_L12));

    constant("DIST_L2", static_cast<long>(cv::DIST_L2));

    constant("DIST_LABEL_CCOMP", static_cast<long>(cv::DIST_LABEL_CCOMP));

    constant("DIST_LABEL_PIXEL", static_cast<long>(cv::DIST_LABEL_PIXEL));

    constant("DIST_MASK_3", static_cast<long>(cv::DIST_MASK_3));

    constant("DIST_MASK_5", static_cast<long>(cv::DIST_MASK_5));

    constant("DIST_MASK_PRECISE", static_cast<long>(cv::DIST_MASK_PRECISE));

    constant("DIST_USER", static_cast<long>(cv::DIST_USER));

    constant("DIST_WELSCH", static_cast<long>(cv::DIST_WELSCH));

    constant("DescriptorMatcher_BRUTEFORCE", static_cast<long>(cv::DescriptorMatcher::BRUTEFORCE));

    constant("DescriptorMatcher_BRUTEFORCE_HAMMING", static_cast<long>(cv::DescriptorMatcher::BRUTEFORCE_HAMMING));

    constant("DescriptorMatcher_BRUTEFORCE_HAMMINGLUT", static_cast<long>(cv::DescriptorMatcher::BRUTEFORCE_HAMMINGLUT));

    constant("DescriptorMatcher_BRUTEFORCE_L1", static_cast<long>(cv::DescriptorMatcher::BRUTEFORCE_L1));

    constant("DescriptorMatcher_BRUTEFORCE_SL2", static_cast<long>(cv::DescriptorMatcher::BRUTEFORCE_SL2));

    constant("DescriptorMatcher_FLANNBASED", static_cast<long>(cv::DescriptorMatcher::FLANNBASED));

    constant("DrawMatchesFlags_DEFAULT", static_cast<long>(cv::DrawMatchesFlags::DEFAULT));

    constant("DrawMatchesFlags_DRAW_OVER_OUTIMG", static_cast<long>(cv::DrawMatchesFlags::DRAW_OVER_OUTIMG));

    constant("DrawMatchesFlags_DRAW_RICH_KEYPOINTS", static_cast<long>(cv::DrawMatchesFlags::DRAW_RICH_KEYPOINTS));

    constant("DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS", static_cast<long>(cv::DrawMatchesFlags::NOT_DRAW_SINGLE_POINTS));

    constant("FILLED", static_cast<long>(cv::FILLED));

    constant("FILTER_SCHARR", static_cast<long>(cv::FILTER_SCHARR));

    constant("FLOODFILL_FIXED_RANGE", static_cast<long>(cv::FLOODFILL_FIXED_RANGE));

    constant("FLOODFILL_MASK_ONLY", static_cast<long>(cv::FLOODFILL_MASK_ONLY));

    constant("FM_7POINT", static_cast<long>(cv::FM_7POINT));

    constant("FM_8POINT", static_cast<long>(cv::FM_8POINT));

    constant("FM_LMEDS", static_cast<long>(cv::FM_LMEDS));

    constant("FM_RANSAC", static_cast<long>(cv::FM_RANSAC));

    constant("FONT_HERSHEY_COMPLEX", static_cast<long>(cv::FONT_HERSHEY_COMPLEX));

    constant("FONT_HERSHEY_COMPLEX_SMALL", static_cast<long>(cv::FONT_HERSHEY_COMPLEX_SMALL));

    constant("FONT_HERSHEY_DUPLEX", static_cast<long>(cv::FONT_HERSHEY_DUPLEX));

    constant("FONT_HERSHEY_PLAIN", static_cast<long>(cv::FONT_HERSHEY_PLAIN));

    constant("FONT_HERSHEY_SCRIPT_COMPLEX", static_cast<long>(cv::FONT_HERSHEY_SCRIPT_COMPLEX));

    constant("FONT_HERSHEY_SCRIPT_SIMPLEX", static_cast<long>(cv::FONT_HERSHEY_SCRIPT_SIMPLEX));

    constant("FONT_HERSHEY_SIMPLEX", static_cast<long>(cv::FONT_HERSHEY_SIMPLEX));

    constant("FONT_HERSHEY_TRIPLEX", static_cast<long>(cv::FONT_HERSHEY_TRIPLEX));

    constant("FONT_ITALIC", static_cast<long>(cv::FONT_ITALIC));

    constant("FaceRecognizerSF_FR_COSINE", static_cast<long>(cv::FaceRecognizerSF::FR_COSINE));

    constant("FaceRecognizerSF_FR_NORM_L2", static_cast<long>(cv::FaceRecognizerSF::FR_NORM_L2));

    constant("FastFeatureDetector_FAST_N", static_cast<long>(cv::FastFeatureDetector::FAST_N));

    constant("FastFeatureDetector_NONMAX_SUPPRESSION", static_cast<long>(cv::FastFeatureDetector::NONMAX_SUPPRESSION));

    constant("FastFeatureDetector_THRESHOLD", static_cast<long>(cv::FastFeatureDetector::THRESHOLD));

    constant("FastFeatureDetector_TYPE_5_8", static_cast<long>(cv::FastFeatureDetector::TYPE_5_8));

    constant("FastFeatureDetector_TYPE_7_12", static_cast<long>(cv::FastFeatureDetector::TYPE_7_12));

    constant("FastFeatureDetector_TYPE_9_16", static_cast<long>(cv::FastFeatureDetector::TYPE_9_16));

    constant("FileNode_EMPTY", static_cast<long>(cv::FileNode::EMPTY));

    constant("FileNode_FLOAT", static_cast<long>(cv::FileNode::FLOAT));

    constant("FileNode_FLOW", static_cast<long>(cv::FileNode::FLOW));

    constant("FileNode_INT", static_cast<long>(cv::FileNode::INT));

    constant("FileNode_MAP", static_cast<long>(cv::FileNode::MAP));

    constant("FileNode_NAMED", static_cast<long>(cv::FileNode::NAMED));

    constant("FileNode_NONE", static_cast<long>(cv::FileNode::NONE));

    constant("FileNode_REAL", static_cast<long>(cv::FileNode::REAL));

    constant("FileNode_SEQ", static_cast<long>(cv::FileNode::SEQ));

    constant("FileNode_STR", static_cast<long>(cv::FileNode::STR));

    constant("FileNode_STRING", static_cast<long>(cv::FileNode::STRING));

    constant("FileNode_TYPE_MASK", static_cast<long>(cv::FileNode::TYPE_MASK));

    constant("FileNode_UNIFORM", static_cast<long>(cv::FileNode::UNIFORM));

    constant("FileStorage_APPEND", static_cast<long>(cv::FileStorage::APPEND));

    constant("FileStorage_BASE64", static_cast<long>(cv::FileStorage::BASE64));

    constant("FileStorage_FORMAT_AUTO", static_cast<long>(cv::FileStorage::FORMAT_AUTO));

    constant("FileStorage_FORMAT_JSON", static_cast<long>(cv::FileStorage::FORMAT_JSON));

    constant("FileStorage_FORMAT_MASK", static_cast<long>(cv::FileStorage::FORMAT_MASK));

    constant("FileStorage_FORMAT_XML", static_cast<long>(cv::FileStorage::FORMAT_XML));

    constant("FileStorage_FORMAT_YAML", static_cast<long>(cv::FileStorage::FORMAT_YAML));

    constant("FileStorage_INSIDE_MAP", static_cast<long>(cv::FileStorage::INSIDE_MAP));

    constant("FileStorage_MEMORY", static_cast<long>(cv::FileStorage::MEMORY));

    constant("FileStorage_NAME_EXPECTED", static_cast<long>(cv::FileStorage::NAME_EXPECTED));

    constant("FileStorage_READ", static_cast<long>(cv::FileStorage::READ));

    constant("FileStorage_UNDEFINED", static_cast<long>(cv::FileStorage::UNDEFINED));

    constant("FileStorage_VALUE_EXPECTED", static_cast<long>(cv::FileStorage::VALUE_EXPECTED));

    constant("FileStorage_WRITE", static_cast<long>(cv::FileStorage::WRITE));

    constant("FileStorage_WRITE_BASE64", static_cast<long>(cv::FileStorage::WRITE_BASE64));

    constant("Formatter_FMT_C", static_cast<long>(cv::Formatter::FMT_C));

    constant("Formatter_FMT_CSV", static_cast<long>(cv::Formatter::FMT_CSV));

    constant("Formatter_FMT_DEFAULT", static_cast<long>(cv::Formatter::FMT_DEFAULT));

    constant("Formatter_FMT_MATLAB", static_cast<long>(cv::Formatter::FMT_MATLAB));

    constant("Formatter_FMT_NUMPY", static_cast<long>(cv::Formatter::FMT_NUMPY));

    constant("Formatter_FMT_PYTHON", static_cast<long>(cv::Formatter::FMT_PYTHON));

    constant("GC_BGD", static_cast<long>(cv::GC_BGD));

    constant("GC_EVAL", static_cast<long>(cv::GC_EVAL));

    constant("GC_EVAL_FREEZE_MODEL", static_cast<long>(cv::GC_EVAL_FREEZE_MODEL));

    constant("GC_FGD", static_cast<long>(cv::GC_FGD));

    constant("GC_INIT_WITH_MASK", static_cast<long>(cv::GC_INIT_WITH_MASK));

    constant("GC_INIT_WITH_RECT", static_cast<long>(cv::GC_INIT_WITH_RECT));

    constant("GC_PR_BGD", static_cast<long>(cv::GC_PR_BGD));

    constant("GC_PR_FGD", static_cast<long>(cv::GC_PR_FGD));

    constant("GEMM_1_T", static_cast<long>(cv::GEMM_1_T));

    constant("GEMM_2_T", static_cast<long>(cv::GEMM_2_T));

    constant("GEMM_3_T", static_cast<long>(cv::GEMM_3_T));

    constant("HISTCMP_BHATTACHARYYA", static_cast<long>(cv::HISTCMP_BHATTACHARYYA));

    constant("HISTCMP_CHISQR", static_cast<long>(cv::HISTCMP_CHISQR));

    constant("HISTCMP_CHISQR_ALT", static_cast<long>(cv::HISTCMP_CHISQR_ALT));

    constant("HISTCMP_CORREL", static_cast<long>(cv::HISTCMP_CORREL));

    constant("HISTCMP_HELLINGER", static_cast<long>(cv::HISTCMP_HELLINGER));

    constant("HISTCMP_INTERSECT", static_cast<long>(cv::HISTCMP_INTERSECT));

    constant("HISTCMP_KL_DIV", static_cast<long>(cv::HISTCMP_KL_DIV));

    constant("HOGDescriptor_DEFAULT_NLEVELS", static_cast<long>(cv::HOGDescriptor::DEFAULT_NLEVELS));

    constant("HOGDescriptor_DESCR_FORMAT_COL_BY_COL", static_cast<long>(cv::HOGDescriptor::DESCR_FORMAT_COL_BY_COL));

    constant("HOGDescriptor_DESCR_FORMAT_ROW_BY_ROW", static_cast<long>(cv::HOGDescriptor::DESCR_FORMAT_ROW_BY_ROW));

    constant("HOGDescriptor_L2Hys", static_cast<long>(cv::HOGDescriptor::L2Hys));

    constant("HOUGH_GRADIENT", static_cast<long>(cv::HOUGH_GRADIENT));

    constant("HOUGH_GRADIENT_ALT", static_cast<long>(cv::HOUGH_GRADIENT_ALT));

    constant("HOUGH_MULTI_SCALE", static_cast<long>(cv::HOUGH_MULTI_SCALE));

    constant("HOUGH_PROBABILISTIC", static_cast<long>(cv::HOUGH_PROBABILISTIC));

    constant("HOUGH_STANDARD", static_cast<long>(cv::HOUGH_STANDARD));

    constant("INPAINT_NS", static_cast<long>(cv::INPAINT_NS));

    constant("INPAINT_TELEA", static_cast<long>(cv::INPAINT_TELEA));

    constant("INTERSECT_FULL", static_cast<long>(cv::INTERSECT_FULL));

    constant("INTERSECT_NONE", static_cast<long>(cv::INTERSECT_NONE));

    constant("INTERSECT_PARTIAL", static_cast<long>(cv::INTERSECT_PARTIAL));

    constant("INTER_AREA", static_cast<long>(cv::INTER_AREA));

    constant("INTER_BITS", static_cast<long>(cv::INTER_BITS));

    constant("INTER_BITS2", static_cast<long>(cv::INTER_BITS2));

    constant("INTER_CUBIC", static_cast<long>(cv::INTER_CUBIC));

    constant("INTER_LANCZOS4", static_cast<long>(cv::INTER_LANCZOS4));

    constant("INTER_LINEAR", static_cast<long>(cv::INTER_LINEAR));

    constant("INTER_LINEAR_EXACT", static_cast<long>(cv::INTER_LINEAR_EXACT));

    constant("INTER_MAX", static_cast<long>(cv::INTER_MAX));

    constant("INTER_NEAREST", static_cast<long>(cv::INTER_NEAREST));

    constant("INTER_NEAREST_EXACT", static_cast<long>(cv::INTER_NEAREST_EXACT));

    constant("INTER_TAB_SIZE", static_cast<long>(cv::INTER_TAB_SIZE));

    constant("INTER_TAB_SIZE2", static_cast<long>(cv::INTER_TAB_SIZE2));

    constant("KAZE_DIFF_CHARBONNIER", static_cast<long>(cv::KAZE::DIFF_CHARBONNIER));

    constant("KAZE_DIFF_PM_G1", static_cast<long>(cv::KAZE::DIFF_PM_G1));

    constant("KAZE_DIFF_PM_G2", static_cast<long>(cv::KAZE::DIFF_PM_G2));

    constant("KAZE_DIFF_WEICKERT", static_cast<long>(cv::KAZE::DIFF_WEICKERT));

    constant("KMEANS_PP_CENTERS", static_cast<long>(cv::KMEANS_PP_CENTERS));

    constant("KMEANS_RANDOM_CENTERS", static_cast<long>(cv::KMEANS_RANDOM_CENTERS));

    constant("KMEANS_USE_INITIAL_LABELS", static_cast<long>(cv::KMEANS_USE_INITIAL_LABELS));

    constant("LDR_SIZE", static_cast<long>(cv::LDR_SIZE));

    constant("LINE_4", static_cast<long>(cv::LINE_4));

    constant("LINE_8", static_cast<long>(cv::LINE_8));

    constant("LINE_AA", static_cast<long>(cv::LINE_AA));

    constant("LMEDS", static_cast<long>(cv::LMEDS));

    constant("LOCAL_OPTIM_GC", static_cast<long>(cv::LOCAL_OPTIM_GC));

    constant("LOCAL_OPTIM_INNER_AND_ITER_LO", static_cast<long>(cv::LOCAL_OPTIM_INNER_AND_ITER_LO));

    constant("LOCAL_OPTIM_INNER_LO", static_cast<long>(cv::LOCAL_OPTIM_INNER_LO));

    constant("LOCAL_OPTIM_NULL", static_cast<long>(cv::LOCAL_OPTIM_NULL));

    constant("LOCAL_OPTIM_SIGMA", static_cast<long>(cv::LOCAL_OPTIM_SIGMA));

    constant("LSD_REFINE_ADV", static_cast<long>(cv::LSD_REFINE_ADV));

    constant("LSD_REFINE_NONE", static_cast<long>(cv::LSD_REFINE_NONE));

    constant("LSD_REFINE_STD", static_cast<long>(cv::LSD_REFINE_STD));

    constant("LSQ_POLISHER", static_cast<long>(cv::LSQ_POLISHER));

    constant("MAGSAC", static_cast<long>(cv::MAGSAC));

    constant("MARKER_CROSS", static_cast<long>(cv::MARKER_CROSS));

    constant("MARKER_DIAMOND", static_cast<long>(cv::MARKER_DIAMOND));

    constant("MARKER_SQUARE", static_cast<long>(cv::MARKER_SQUARE));

    constant("MARKER_STAR", static_cast<long>(cv::MARKER_STAR));

    constant("MARKER_TILTED_CROSS", static_cast<long>(cv::MARKER_TILTED_CROSS));

    constant("MARKER_TRIANGLE_DOWN", static_cast<long>(cv::MARKER_TRIANGLE_DOWN));

    constant("MARKER_TRIANGLE_UP", static_cast<long>(cv::MARKER_TRIANGLE_UP));

    constant("MIXED_CLONE", static_cast<long>(cv::MIXED_CLONE));

    constant("MIXED_CLONE_WIDE", static_cast<long>(cv::MIXED_CLONE_WIDE));

    constant("MONOCHROME_TRANSFER", static_cast<long>(cv::MONOCHROME_TRANSFER));

    constant("MONOCHROME_TRANSFER_WIDE", static_cast<long>(cv::MONOCHROME_TRANSFER_WIDE));

    constant("MORPH_BLACKHAT", static_cast<long>(cv::MORPH_BLACKHAT));

    constant("MORPH_CLOSE", static_cast<long>(cv::MORPH_CLOSE));

    constant("MORPH_CROSS", static_cast<long>(cv::MORPH_CROSS));

    constant("MORPH_DIAMOND", static_cast<long>(cv::MORPH_DIAMOND));

    constant("MORPH_DILATE", static_cast<long>(cv::MORPH_DILATE));

    constant("MORPH_ELLIPSE", static_cast<long>(cv::MORPH_ELLIPSE));

    constant("MORPH_ERODE", static_cast<long>(cv::MORPH_ERODE));

    constant("MORPH_GRADIENT", static_cast<long>(cv::MORPH_GRADIENT));

    constant("MORPH_HITMISS", static_cast<long>(cv::MORPH_HITMISS));

    constant("MORPH_OPEN", static_cast<long>(cv::MORPH_OPEN));

    constant("MORPH_RECT", static_cast<long>(cv::MORPH_RECT));

    constant("MORPH_TOPHAT", static_cast<long>(cv::MORPH_TOPHAT));

    constant("MOTION_AFFINE", static_cast<long>(cv::MOTION_AFFINE));

    constant("MOTION_EUCLIDEAN", static_cast<long>(cv::MOTION_EUCLIDEAN));

    constant("MOTION_HOMOGRAPHY", static_cast<long>(cv::MOTION_HOMOGRAPHY));

    constant("MOTION_TRANSLATION", static_cast<long>(cv::MOTION_TRANSLATION));

    constant("Mat_AUTO_STEP", static_cast<long>(cv::Mat::AUTO_STEP));

    constant("Mat_CONTINUOUS_FLAG", static_cast<long>(cv::Mat::CONTINUOUS_FLAG));

    constant("Mat_DEPTH_MASK", static_cast<long>(cv::Mat::DEPTH_MASK));

    constant("Mat_MAGIC_MASK", static_cast<long>(cv::Mat::MAGIC_MASK));

    constant("Mat_MAGIC_VAL", static_cast<long>(cv::Mat::MAGIC_VAL));

    constant("Mat_SUBMATRIX_FLAG", static_cast<long>(cv::Mat::SUBMATRIX_FLAG));

    constant("Mat_TYPE_MASK", static_cast<long>(cv::Mat::TYPE_MASK));

    constant("NEIGH_FLANN_KNN", static_cast<long>(cv::NEIGH_FLANN_KNN));

    constant("NEIGH_FLANN_RADIUS", static_cast<long>(cv::NEIGH_FLANN_RADIUS));

    constant("NEIGH_GRID", static_cast<long>(cv::NEIGH_GRID));

    constant("NONE_POLISHER", static_cast<long>(cv::NONE_POLISHER));

    constant("NORMAL_CLONE", static_cast<long>(cv::NORMAL_CLONE));

    constant("NORMAL_CLONE_WIDE", static_cast<long>(cv::NORMAL_CLONE_WIDE));

    constant("NORMCONV_FILTER", static_cast<long>(cv::NORMCONV_FILTER));

    constant("NORM_HAMMING", static_cast<long>(cv::NORM_HAMMING));

    constant("NORM_HAMMING2", static_cast<long>(cv::NORM_HAMMING2));

    constant("NORM_INF", static_cast<long>(cv::NORM_INF));

    constant("NORM_L1", static_cast<long>(cv::NORM_L1));

    constant("NORM_L2", static_cast<long>(cv::NORM_L2));

    constant("NORM_L2SQR", static_cast<long>(cv::NORM_L2SQR));

    constant("NORM_MINMAX", static_cast<long>(cv::NORM_MINMAX));

    constant("NORM_RELATIVE", static_cast<long>(cv::NORM_RELATIVE));

    constant("NORM_TYPE_MASK", static_cast<long>(cv::NORM_TYPE_MASK));

    constant("OPTFLOW_FARNEBACK_GAUSSIAN", static_cast<long>(cv::OPTFLOW_FARNEBACK_GAUSSIAN));

    constant("OPTFLOW_LK_GET_MIN_EIGENVALS", static_cast<long>(cv::OPTFLOW_LK_GET_MIN_EIGENVALS));

    constant("OPTFLOW_USE_INITIAL_FLOW", static_cast<long>(cv::OPTFLOW_USE_INITIAL_FLOW));

    constant("ORB_FAST_SCORE", static_cast<long>(cv::ORB::FAST_SCORE));

    constant("ORB_HARRIS_SCORE", static_cast<long>(cv::ORB::HARRIS_SCORE));

    constant("PCA_DATA_AS_COL", static_cast<long>(cv::PCA::DATA_AS_COL));

    constant("PCA_DATA_AS_ROW", static_cast<long>(cv::PCA::DATA_AS_ROW));

    constant("PCA_USE_AVG", static_cast<long>(cv::PCA::USE_AVG));

    constant("PROJ_SPHERICAL_EQRECT", static_cast<long>(cv::PROJ_SPHERICAL_EQRECT));

    constant("PROJ_SPHERICAL_ORTHO", static_cast<long>(cv::PROJ_SPHERICAL_ORTHO));

    constant("Param_ALGORITHM", static_cast<long>(cv::Param::ALGORITHM));

    constant("Param_BOOLEAN", static_cast<long>(cv::Param::BOOLEAN));

    constant("Param_FLOAT", static_cast<long>(cv::Param::FLOAT));

    constant("Param_INT", static_cast<long>(cv::Param::INT));

    constant("Param_MAT", static_cast<long>(cv::Param::MAT));

    constant("Param_MAT_VECTOR", static_cast<long>(cv::Param::MAT_VECTOR));

    constant("Param_REAL", static_cast<long>(cv::Param::REAL));

    constant("Param_SCALAR", static_cast<long>(cv::Param::SCALAR));

    constant("Param_STRING", static_cast<long>(cv::Param::STRING));

    constant("Param_UCHAR", static_cast<long>(cv::Param::UCHAR));

    constant("Param_UINT64", static_cast<long>(cv::Param::UINT64));

    constant("Param_UNSIGNED_INT", static_cast<long>(cv::Param::UNSIGNED_INT));

    constant("QRCodeEncoder_CORRECT_LEVEL_H", static_cast<long>(cv::QRCodeEncoder::CORRECT_LEVEL_H));

    constant("QRCodeEncoder_CORRECT_LEVEL_L", static_cast<long>(cv::QRCodeEncoder::CORRECT_LEVEL_L));

    constant("QRCodeEncoder_CORRECT_LEVEL_M", static_cast<long>(cv::QRCodeEncoder::CORRECT_LEVEL_M));

    constant("QRCodeEncoder_CORRECT_LEVEL_Q", static_cast<long>(cv::QRCodeEncoder::CORRECT_LEVEL_Q));

    constant("QRCodeEncoder_ECI_SHIFT_JIS", static_cast<long>(cv::QRCodeEncoder::ECI_SHIFT_JIS));

    constant("QRCodeEncoder_ECI_UTF8", static_cast<long>(cv::QRCodeEncoder::ECI_UTF8));

    constant("QRCodeEncoder_MODE_ALPHANUMERIC", static_cast<long>(cv::QRCodeEncoder::MODE_ALPHANUMERIC));

    constant("QRCodeEncoder_MODE_AUTO", static_cast<long>(cv::QRCodeEncoder::MODE_AUTO));

    constant("QRCodeEncoder_MODE_BYTE", static_cast<long>(cv::QRCodeEncoder::MODE_BYTE));

    constant("QRCodeEncoder_MODE_ECI", static_cast<long>(cv::QRCodeEncoder::MODE_ECI));

    constant("QRCodeEncoder_MODE_KANJI", static_cast<long>(cv::QRCodeEncoder::MODE_KANJI));

    constant("QRCodeEncoder_MODE_NUMERIC", static_cast<long>(cv::QRCodeEncoder::MODE_NUMERIC));

    constant("QRCodeEncoder_MODE_STRUCTURED_APPEND", static_cast<long>(cv::QRCodeEncoder::MODE_STRUCTURED_APPEND));

    constant("QUAT_ASSUME_NOT_UNIT", static_cast<long>(cv::QUAT_ASSUME_NOT_UNIT));

    constant("QUAT_ASSUME_UNIT", static_cast<long>(cv::QUAT_ASSUME_UNIT));

    constant("QuatEnum_EULER_ANGLES_MAX_VALUE", static_cast<long>(cv::QuatEnum::EULER_ANGLES_MAX_VALUE));

    constant("QuatEnum_EXT_XYX", static_cast<long>(cv::QuatEnum::EXT_XYX));

    constant("QuatEnum_EXT_XYZ", static_cast<long>(cv::QuatEnum::EXT_XYZ));

    constant("QuatEnum_EXT_XZX", static_cast<long>(cv::QuatEnum::EXT_XZX));

    constant("QuatEnum_EXT_XZY", static_cast<long>(cv::QuatEnum::EXT_XZY));

    constant("QuatEnum_EXT_YXY", static_cast<long>(cv::QuatEnum::EXT_YXY));

    constant("QuatEnum_EXT_YXZ", static_cast<long>(cv::QuatEnum::EXT_YXZ));

    constant("QuatEnum_EXT_YZX", static_cast<long>(cv::QuatEnum::EXT_YZX));

    constant("QuatEnum_EXT_YZY", static_cast<long>(cv::QuatEnum::EXT_YZY));

    constant("QuatEnum_EXT_ZXY", static_cast<long>(cv::QuatEnum::EXT_ZXY));

    constant("QuatEnum_EXT_ZXZ", static_cast<long>(cv::QuatEnum::EXT_ZXZ));

    constant("QuatEnum_EXT_ZYX", static_cast<long>(cv::QuatEnum::EXT_ZYX));

    constant("QuatEnum_EXT_ZYZ", static_cast<long>(cv::QuatEnum::EXT_ZYZ));

    constant("QuatEnum_INT_XYX", static_cast<long>(cv::QuatEnum::INT_XYX));

    constant("QuatEnum_INT_XYZ", static_cast<long>(cv::QuatEnum::INT_XYZ));

    constant("QuatEnum_INT_XZX", static_cast<long>(cv::QuatEnum::INT_XZX));

    constant("QuatEnum_INT_XZY", static_cast<long>(cv::QuatEnum::INT_XZY));

    constant("QuatEnum_INT_YXY", static_cast<long>(cv::QuatEnum::INT_YXY));

    constant("QuatEnum_INT_YXZ", static_cast<long>(cv::QuatEnum::INT_YXZ));

    constant("QuatEnum_INT_YZX", static_cast<long>(cv::QuatEnum::INT_YZX));

    constant("QuatEnum_INT_YZY", static_cast<long>(cv::QuatEnum::INT_YZY));

    constant("QuatEnum_INT_ZXY", static_cast<long>(cv::QuatEnum::INT_ZXY));

    constant("QuatEnum_INT_ZXZ", static_cast<long>(cv::QuatEnum::INT_ZXZ));

    constant("QuatEnum_INT_ZYX", static_cast<long>(cv::QuatEnum::INT_ZYX));

    constant("QuatEnum_INT_ZYZ", static_cast<long>(cv::QuatEnum::INT_ZYZ));

    constant("RANSAC", static_cast<long>(cv::RANSAC));

    constant("RECURS_FILTER", static_cast<long>(cv::RECURS_FILTER));

    constant("REDUCE_AVG", static_cast<long>(cv::REDUCE_AVG));

    constant("REDUCE_MAX", static_cast<long>(cv::REDUCE_MAX));

    constant("REDUCE_MIN", static_cast<long>(cv::REDUCE_MIN));

    constant("REDUCE_SUM", static_cast<long>(cv::REDUCE_SUM));

    constant("REDUCE_SUM2", static_cast<long>(cv::REDUCE_SUM2));

    constant("RETR_CCOMP", static_cast<long>(cv::RETR_CCOMP));

    constant("RETR_EXTERNAL", static_cast<long>(cv::RETR_EXTERNAL));

    constant("RETR_FLOODFILL", static_cast<long>(cv::RETR_FLOODFILL));

    constant("RETR_LIST", static_cast<long>(cv::RETR_LIST));

    constant("RETR_TREE", static_cast<long>(cv::RETR_TREE));

    constant("RHO", static_cast<long>(cv::RHO));

    constant("RNG_NORMAL", static_cast<long>(cv::RNG::NORMAL));

    constant("RNG_UNIFORM", static_cast<long>(cv::RNG::UNIFORM));

    constant("ROTATE_180", static_cast<long>(cv::ROTATE_180));

    constant("ROTATE_90_CLOCKWISE", static_cast<long>(cv::ROTATE_90_CLOCKWISE));

    constant("ROTATE_90_COUNTERCLOCKWISE", static_cast<long>(cv::ROTATE_90_COUNTERCLOCKWISE));

    constant("SAMPLING_NAPSAC", static_cast<long>(cv::SAMPLING_NAPSAC));

    constant("SAMPLING_PROGRESSIVE_NAPSAC", static_cast<long>(cv::SAMPLING_PROGRESSIVE_NAPSAC));

    constant("SAMPLING_PROSAC", static_cast<long>(cv::SAMPLING_PROSAC));

    constant("SAMPLING_UNIFORM", static_cast<long>(cv::SAMPLING_UNIFORM));

    constant("SCORE_METHOD_LMEDS", static_cast<long>(cv::SCORE_METHOD_LMEDS));

    constant("SCORE_METHOD_MAGSAC", static_cast<long>(cv::SCORE_METHOD_MAGSAC));

    constant("SCORE_METHOD_MSAC", static_cast<long>(cv::SCORE_METHOD_MSAC));

    constant("SCORE_METHOD_RANSAC", static_cast<long>(cv::SCORE_METHOD_RANSAC));

    constant("SOLVELP_LOST", static_cast<long>(cv::SOLVELP_LOST));

    constant("SOLVELP_MULTI", static_cast<long>(cv::SOLVELP_MULTI));

    constant("SOLVELP_SINGLE", static_cast<long>(cv::SOLVELP_SINGLE));

    constant("SOLVELP_UNBOUNDED", static_cast<long>(cv::SOLVELP_UNBOUNDED));

    constant("SOLVELP_UNFEASIBLE", static_cast<long>(cv::SOLVELP_UNFEASIBLE));

    constant("SOLVEPNP_AP3P", static_cast<long>(cv::SOLVEPNP_AP3P));

    constant("SOLVEPNP_DLS", static_cast<long>(cv::SOLVEPNP_DLS));

    constant("SOLVEPNP_EPNP", static_cast<long>(cv::SOLVEPNP_EPNP));

    constant("SOLVEPNP_IPPE", static_cast<long>(cv::SOLVEPNP_IPPE));

    constant("SOLVEPNP_IPPE_SQUARE", static_cast<long>(cv::SOLVEPNP_IPPE_SQUARE));

    constant("SOLVEPNP_ITERATIVE", static_cast<long>(cv::SOLVEPNP_ITERATIVE));

    constant("SOLVEPNP_MAX_COUNT", static_cast<long>(cv::SOLVEPNP_MAX_COUNT));

    constant("SOLVEPNP_P3P", static_cast<long>(cv::SOLVEPNP_P3P));

    constant("SOLVEPNP_SQPNP", static_cast<long>(cv::SOLVEPNP_SQPNP));

    constant("SOLVEPNP_UPNP", static_cast<long>(cv::SOLVEPNP_UPNP));

    constant("SORT_ASCENDING", static_cast<long>(cv::SORT_ASCENDING));

    constant("SORT_DESCENDING", static_cast<long>(cv::SORT_DESCENDING));

    constant("SORT_EVERY_COLUMN", static_cast<long>(cv::SORT_EVERY_COLUMN));

    constant("SORT_EVERY_ROW", static_cast<long>(cv::SORT_EVERY_ROW));

    constant("SVD_FULL_UV", static_cast<long>(cv::SVD::FULL_UV));

    constant("SVD_MODIFY_A", static_cast<long>(cv::SVD::MODIFY_A));

    constant("SVD_NO_UV", static_cast<long>(cv::SVD::NO_UV));

    constant("SparseMat_HASH_BIT", static_cast<long>(cv::SparseMat::HASH_BIT));

    constant("SparseMat_HASH_SCALE", static_cast<long>(cv::SparseMat::HASH_SCALE));

    constant("SparseMat_MAGIC_VAL", static_cast<long>(cv::SparseMat::MAGIC_VAL));

    constant("SparseMat_MAX_DIM", static_cast<long>(cv::SparseMat::MAX_DIM));

    constant("StereoBM_PREFILTER_NORMALIZED_RESPONSE", static_cast<long>(cv::StereoBM::PREFILTER_NORMALIZED_RESPONSE));

    constant("StereoBM_PREFILTER_XSOBEL", static_cast<long>(cv::StereoBM::PREFILTER_XSOBEL));

    constant("StereoMatcher_DISP_SCALE", static_cast<long>(cv::StereoMatcher::DISP_SCALE));

    constant("StereoMatcher_DISP_SHIFT", static_cast<long>(cv::StereoMatcher::DISP_SHIFT));

    constant("StereoSGBM_MODE_HH", static_cast<long>(cv::StereoSGBM::MODE_HH));

    constant("StereoSGBM_MODE_HH4", static_cast<long>(cv::StereoSGBM::MODE_HH4));

    constant("StereoSGBM_MODE_SGBM", static_cast<long>(cv::StereoSGBM::MODE_SGBM));

    constant("StereoSGBM_MODE_SGBM_3WAY", static_cast<long>(cv::StereoSGBM::MODE_SGBM_3WAY));

    constant("Subdiv2D_NEXT_AROUND_DST", static_cast<long>(cv::Subdiv2D::NEXT_AROUND_DST));

    constant("Subdiv2D_NEXT_AROUND_LEFT", static_cast<long>(cv::Subdiv2D::NEXT_AROUND_LEFT));

    constant("Subdiv2D_NEXT_AROUND_ORG", static_cast<long>(cv::Subdiv2D::NEXT_AROUND_ORG));

    constant("Subdiv2D_NEXT_AROUND_RIGHT", static_cast<long>(cv::Subdiv2D::NEXT_AROUND_RIGHT));

    constant("Subdiv2D_PREV_AROUND_DST", static_cast<long>(cv::Subdiv2D::PREV_AROUND_DST));

    constant("Subdiv2D_PREV_AROUND_LEFT", static_cast<long>(cv::Subdiv2D::PREV_AROUND_LEFT));

    constant("Subdiv2D_PREV_AROUND_ORG", static_cast<long>(cv::Subdiv2D::PREV_AROUND_ORG));

    constant("Subdiv2D_PREV_AROUND_RIGHT", static_cast<long>(cv::Subdiv2D::PREV_AROUND_RIGHT));

    constant("Subdiv2D_PTLOC_ERROR", static_cast<long>(cv::Subdiv2D::PTLOC_ERROR));

    constant("Subdiv2D_PTLOC_INSIDE", static_cast<long>(cv::Subdiv2D::PTLOC_INSIDE));

    constant("Subdiv2D_PTLOC_ON_EDGE", static_cast<long>(cv::Subdiv2D::PTLOC_ON_EDGE));

    constant("Subdiv2D_PTLOC_OUTSIDE_RECT", static_cast<long>(cv::Subdiv2D::PTLOC_OUTSIDE_RECT));

    constant("Subdiv2D_PTLOC_VERTEX", static_cast<long>(cv::Subdiv2D::PTLOC_VERTEX));

    constant("THRESH_BINARY", static_cast<long>(cv::THRESH_BINARY));

    constant("THRESH_BINARY_INV", static_cast<long>(cv::THRESH_BINARY_INV));

    constant("THRESH_DRYRUN", static_cast<long>(cv::THRESH_DRYRUN));

    constant("THRESH_MASK", static_cast<long>(cv::THRESH_MASK));

    constant("THRESH_OTSU", static_cast<long>(cv::THRESH_OTSU));

    constant("THRESH_TOZERO", static_cast<long>(cv::THRESH_TOZERO));

    constant("THRESH_TOZERO_INV", static_cast<long>(cv::THRESH_TOZERO_INV));

    constant("THRESH_TRIANGLE", static_cast<long>(cv::THRESH_TRIANGLE));

    constant("THRESH_TRUNC", static_cast<long>(cv::THRESH_TRUNC));

    constant("TM_CCOEFF", static_cast<long>(cv::TM_CCOEFF));

    constant("TM_CCOEFF_NORMED", static_cast<long>(cv::TM_CCOEFF_NORMED));

    constant("TM_CCORR", static_cast<long>(cv::TM_CCORR));

    constant("TM_CCORR_NORMED", static_cast<long>(cv::TM_CCORR_NORMED));

    constant("TM_SQDIFF", static_cast<long>(cv::TM_SQDIFF));

    constant("TM_SQDIFF_NORMED", static_cast<long>(cv::TM_SQDIFF_NORMED));

    constant("TermCriteria_COUNT", static_cast<long>(cv::TermCriteria::COUNT));

    constant("TermCriteria_EPS", static_cast<long>(cv::TermCriteria::EPS));

    constant("TermCriteria_MAX_ITER", static_cast<long>(cv::TermCriteria::MAX_ITER));

    constant("UMatData_ASYNC_CLEANUP", static_cast<long>(cv::UMatData::ASYNC_CLEANUP));

    constant("UMatData_COPY_ON_MAP", static_cast<long>(cv::UMatData::COPY_ON_MAP));

    constant("UMatData_DEVICE_COPY_OBSOLETE", static_cast<long>(cv::UMatData::DEVICE_COPY_OBSOLETE));

    constant("UMatData_DEVICE_MEM_MAPPED", static_cast<long>(cv::UMatData::DEVICE_MEM_MAPPED));

    constant("UMatData_HOST_COPY_OBSOLETE", static_cast<long>(cv::UMatData::HOST_COPY_OBSOLETE));

    constant("UMatData_TEMP_COPIED_UMAT", static_cast<long>(cv::UMatData::TEMP_COPIED_UMAT));

    constant("UMatData_TEMP_UMAT", static_cast<long>(cv::UMatData::TEMP_UMAT));

    constant("UMatData_USER_ALLOCATED", static_cast<long>(cv::UMatData::USER_ALLOCATED));

    constant("UMat_AUTO_STEP", static_cast<long>(cv::UMat::AUTO_STEP));

    constant("UMat_CONTINUOUS_FLAG", static_cast<long>(cv::UMat::CONTINUOUS_FLAG));

    constant("UMat_DEPTH_MASK", static_cast<long>(cv::UMat::DEPTH_MASK));

    constant("UMat_MAGIC_MASK", static_cast<long>(cv::UMat::MAGIC_MASK));

    constant("UMat_MAGIC_VAL", static_cast<long>(cv::UMat::MAGIC_VAL));

    constant("UMat_SUBMATRIX_FLAG", static_cast<long>(cv::UMat::SUBMATRIX_FLAG));

    constant("UMat_TYPE_MASK", static_cast<long>(cv::UMat::TYPE_MASK));

    constant("USAC_ACCURATE", static_cast<long>(cv::USAC_ACCURATE));

    constant("USAC_DEFAULT", static_cast<long>(cv::USAC_DEFAULT));

    constant("USAC_FAST", static_cast<long>(cv::USAC_FAST));

    constant("USAC_FM_8PTS", static_cast<long>(cv::USAC_FM_8PTS));

    constant("USAC_MAGSAC", static_cast<long>(cv::USAC_MAGSAC));

    constant("USAC_PARALLEL", static_cast<long>(cv::USAC_PARALLEL));

    constant("USAC_PROSAC", static_cast<long>(cv::USAC_PROSAC));

    constant("USAGE_ALLOCATE_DEVICE_MEMORY", static_cast<long>(cv::USAGE_ALLOCATE_DEVICE_MEMORY));

    constant("USAGE_ALLOCATE_HOST_MEMORY", static_cast<long>(cv::USAGE_ALLOCATE_HOST_MEMORY));

    constant("USAGE_ALLOCATE_SHARED_MEMORY", static_cast<long>(cv::USAGE_ALLOCATE_SHARED_MEMORY));

    constant("USAGE_DEFAULT", static_cast<long>(cv::USAGE_DEFAULT));

    constant("WARP_FILL_OUTLIERS", static_cast<long>(cv::WARP_FILL_OUTLIERS));

    constant("WARP_INVERSE_MAP", static_cast<long>(cv::WARP_INVERSE_MAP));

    constant("WARP_POLAR_LINEAR", static_cast<long>(cv::WARP_POLAR_LINEAR));

    constant("WARP_POLAR_LOG", static_cast<long>(cv::WARP_POLAR_LOG));

    constant("WARP_RELATIVE_MAP", static_cast<long>(cv::WARP_RELATIVE_MAP));

    constant("_InputArray_CUDA_GPU_MAT", static_cast<long>(cv::_InputArray::CUDA_GPU_MAT));

    constant("_InputArray_CUDA_GPU_MATND", static_cast<long>(cv::_InputArray::CUDA_GPU_MATND));

    constant("_InputArray_CUDA_HOST_MEM", static_cast<long>(cv::_InputArray::CUDA_HOST_MEM));

    constant("_InputArray_EXPR", static_cast<long>(cv::_InputArray::EXPR));

    constant("_InputArray_FIXED_SIZE", static_cast<long>(cv::_InputArray::FIXED_SIZE));

    constant("_InputArray_FIXED_TYPE", static_cast<long>(cv::_InputArray::FIXED_TYPE));

    constant("_InputArray_KIND_MASK", static_cast<long>(cv::_InputArray::KIND_MASK));

    constant("_InputArray_KIND_SHIFT", static_cast<long>(cv::_InputArray::KIND_SHIFT));

    constant("_InputArray_MAT", static_cast<long>(cv::_InputArray::MAT));

    constant("_InputArray_MATX", static_cast<long>(cv::_InputArray::MATX));

    constant("_InputArray_NONE", static_cast<long>(cv::_InputArray::NONE));

    constant("_InputArray_OPENGL_BUFFER", static_cast<long>(cv::_InputArray::OPENGL_BUFFER));

    constant("_InputArray_STD_ARRAY", static_cast<long>(cv::_InputArray::STD_ARRAY));

    constant("_InputArray_STD_ARRAY_MAT", static_cast<long>(cv::_InputArray::STD_ARRAY_MAT));

    constant("_InputArray_STD_BOOL_VECTOR", static_cast<long>(cv::_InputArray::STD_BOOL_VECTOR));

    constant("_InputArray_STD_VECTOR", static_cast<long>(cv::_InputArray::STD_VECTOR));

    constant("_InputArray_STD_VECTOR_CUDA_GPU_MAT", static_cast<long>(cv::_InputArray::STD_VECTOR_CUDA_GPU_MAT));

    constant("_InputArray_STD_VECTOR_MAT", static_cast<long>(cv::_InputArray::STD_VECTOR_MAT));

    constant("_InputArray_STD_VECTOR_UMAT", static_cast<long>(cv::_InputArray::STD_VECTOR_UMAT));

    constant("_InputArray_STD_VECTOR_VECTOR", static_cast<long>(cv::_InputArray::STD_VECTOR_VECTOR));

    constant("_InputArray_UMAT", static_cast<long>(cv::_InputArray::UMAT));

    constant("_OutputArray_DEPTH_MASK_16F", static_cast<long>(cv::_OutputArray::DEPTH_MASK_16F));

    constant("_OutputArray_DEPTH_MASK_16S", static_cast<long>(cv::_OutputArray::DEPTH_MASK_16S));

    constant("_OutputArray_DEPTH_MASK_16U", static_cast<long>(cv::_OutputArray::DEPTH_MASK_16U));

    constant("_OutputArray_DEPTH_MASK_32F", static_cast<long>(cv::_OutputArray::DEPTH_MASK_32F));

    constant("_OutputArray_DEPTH_MASK_32S", static_cast<long>(cv::_OutputArray::DEPTH_MASK_32S));

    constant("_OutputArray_DEPTH_MASK_64F", static_cast<long>(cv::_OutputArray::DEPTH_MASK_64F));

    constant("_OutputArray_DEPTH_MASK_8S", static_cast<long>(cv::_OutputArray::DEPTH_MASK_8S));

    constant("_OutputArray_DEPTH_MASK_8U", static_cast<long>(cv::_OutputArray::DEPTH_MASK_8U));

    constant("_OutputArray_DEPTH_MASK_ALL", static_cast<long>(cv::_OutputArray::DEPTH_MASK_ALL));

    constant("_OutputArray_DEPTH_MASK_ALL_16F", static_cast<long>(cv::_OutputArray::DEPTH_MASK_ALL_16F));

    constant("_OutputArray_DEPTH_MASK_ALL_BUT_8S", static_cast<long>(cv::_OutputArray::DEPTH_MASK_ALL_BUT_8S));

    constant("_OutputArray_DEPTH_MASK_FLT", static_cast<long>(cv::_OutputArray::DEPTH_MASK_FLT));

    constant("__UMAT_USAGE_FLAGS_32BIT", static_cast<long>(cv::__UMAT_USAGE_FLAGS_32BIT));

    constant("BadAlign", static_cast<long>(cv::Error::BadAlign));

    constant("BadAlphaChannel", static_cast<long>(cv::Error::BadAlphaChannel));

    constant("BadCOI", static_cast<long>(cv::Error::BadCOI));

    constant("BadCallBack", static_cast<long>(cv::Error::BadCallBack));

    constant("BadDataPtr", static_cast<long>(cv::Error::BadDataPtr));

    constant("BadDepth", static_cast<long>(cv::Error::BadDepth));

    constant("BadImageSize", static_cast<long>(cv::Error::BadImageSize));

    constant("BadModelOrChSeq", static_cast<long>(cv::Error::BadModelOrChSeq));

    constant("BadNumChannel1U", static_cast<long>(cv::Error::BadNumChannel1U));

    constant("BadNumChannels", static_cast<long>(cv::Error::BadNumChannels));

    constant("BadOffset", static_cast<long>(cv::Error::BadOffset));

    constant("BadOrder", static_cast<long>(cv::Error::BadOrder));

    constant("BadOrigin", static_cast<long>(cv::Error::BadOrigin));

    constant("BadROISize", static_cast<long>(cv::Error::BadROISize));

    constant("BadStep", static_cast<long>(cv::Error::BadStep));

    constant("BadTileSize", static_cast<long>(cv::Error::BadTileSize));

    constant("GpuApiCallError", static_cast<long>(cv::Error::GpuApiCallError));

    constant("GpuNotSupported", static_cast<long>(cv::Error::GpuNotSupported));

    constant("HeaderIsNull", static_cast<long>(cv::Error::HeaderIsNull));

    constant("MaskIsTiled", static_cast<long>(cv::Error::MaskIsTiled));

    constant("OpenCLApiCallError", static_cast<long>(cv::Error::OpenCLApiCallError));

    constant("OpenCLDoubleNotSupported", static_cast<long>(cv::Error::OpenCLDoubleNotSupported));

    constant("OpenCLInitError", static_cast<long>(cv::Error::OpenCLInitError));

    constant("OpenCLNoAMDBlasFft", static_cast<long>(cv::Error::OpenCLNoAMDBlasFft));

    constant("OpenGlApiCallError", static_cast<long>(cv::Error::OpenGlApiCallError));

    constant("OpenGlNotSupported", static_cast<long>(cv::Error::OpenGlNotSupported));

    constant("StsAssert", static_cast<long>(cv::Error::StsAssert));

    constant("StsAutoTrace", static_cast<long>(cv::Error::StsAutoTrace));

    constant("StsBackTrace", static_cast<long>(cv::Error::StsBackTrace));

    constant("StsBadArg", static_cast<long>(cv::Error::StsBadArg));

    constant("StsBadFlag", static_cast<long>(cv::Error::StsBadFlag));

    constant("StsBadFunc", static_cast<long>(cv::Error::StsBadFunc));

    constant("StsBadMask", static_cast<long>(cv::Error::StsBadMask));

    constant("StsBadMemBlock", static_cast<long>(cv::Error::StsBadMemBlock));

    constant("StsBadPoint", static_cast<long>(cv::Error::StsBadPoint));

    constant("StsBadSize", static_cast<long>(cv::Error::StsBadSize));

    constant("StsDivByZero", static_cast<long>(cv::Error::StsDivByZero));

    constant("StsError", static_cast<long>(cv::Error::StsError));

    constant("StsFilterOffsetErr", static_cast<long>(cv::Error::StsFilterOffsetErr));

    constant("StsFilterStructContentErr", static_cast<long>(cv::Error::StsFilterStructContentErr));

    constant("StsInplaceNotSupported", static_cast<long>(cv::Error::StsInplaceNotSupported));

    constant("StsInternal", static_cast<long>(cv::Error::StsInternal));

    constant("StsKernelStructContentErr", static_cast<long>(cv::Error::StsKernelStructContentErr));

    constant("StsNoConv", static_cast<long>(cv::Error::StsNoConv));

    constant("StsNoMem", static_cast<long>(cv::Error::StsNoMem));

    constant("StsNotImplemented", static_cast<long>(cv::Error::StsNotImplemented));

    constant("StsNullPtr", static_cast<long>(cv::Error::StsNullPtr));

    constant("StsObjectNotFound", static_cast<long>(cv::Error::StsObjectNotFound));

    constant("StsOk", static_cast<long>(cv::Error::StsOk));

    constant("StsOutOfRange", static_cast<long>(cv::Error::StsOutOfRange));

    constant("StsParseError", static_cast<long>(cv::Error::StsParseError));

    constant("StsUnmatchedFormats", static_cast<long>(cv::Error::StsUnmatchedFormats));

    constant("StsUnmatchedSizes", static_cast<long>(cv::Error::StsUnmatchedSizes));

    constant("StsUnsupportedFormat", static_cast<long>(cv::Error::StsUnsupportedFormat));

    constant("StsVecLengthErr", static_cast<long>(cv::Error::StsVecLengthErr));

    constant("CORNER_REFINE_APRILTAG", static_cast<long>(cv::aruco::CORNER_REFINE_APRILTAG));

    constant("CORNER_REFINE_CONTOUR", static_cast<long>(cv::aruco::CORNER_REFINE_CONTOUR));

    constant("CORNER_REFINE_NONE", static_cast<long>(cv::aruco::CORNER_REFINE_NONE));

    constant("CORNER_REFINE_SUBPIX", static_cast<long>(cv::aruco::CORNER_REFINE_SUBPIX));

    constant("DICT_4X4_100", static_cast<long>(cv::aruco::DICT_4X4_100));

    constant("DICT_4X4_1000", static_cast<long>(cv::aruco::DICT_4X4_1000));

    constant("DICT_4X4_250", static_cast<long>(cv::aruco::DICT_4X4_250));

    constant("DICT_4X4_50", static_cast<long>(cv::aruco::DICT_4X4_50));

    constant("DICT_5X5_100", static_cast<long>(cv::aruco::DICT_5X5_100));

    constant("DICT_5X5_1000", static_cast<long>(cv::aruco::DICT_5X5_1000));

    constant("DICT_5X5_250", static_cast<long>(cv::aruco::DICT_5X5_250));

    constant("DICT_5X5_50", static_cast<long>(cv::aruco::DICT_5X5_50));

    constant("DICT_6X6_100", static_cast<long>(cv::aruco::DICT_6X6_100));

    constant("DICT_6X6_1000", static_cast<long>(cv::aruco::DICT_6X6_1000));

    constant("DICT_6X6_250", static_cast<long>(cv::aruco::DICT_6X6_250));

    constant("DICT_6X6_50", static_cast<long>(cv::aruco::DICT_6X6_50));

    constant("DICT_7X7_100", static_cast<long>(cv::aruco::DICT_7X7_100));

    constant("DICT_7X7_1000", static_cast<long>(cv::aruco::DICT_7X7_1000));

    constant("DICT_7X7_250", static_cast<long>(cv::aruco::DICT_7X7_250));

    constant("DICT_7X7_50", static_cast<long>(cv::aruco::DICT_7X7_50));

    constant("DICT_APRILTAG_16h5", static_cast<long>(cv::aruco::DICT_APRILTAG_16h5));

    constant("DICT_APRILTAG_25h9", static_cast<long>(cv::aruco::DICT_APRILTAG_25h9));

    constant("DICT_APRILTAG_36h10", static_cast<long>(cv::aruco::DICT_APRILTAG_36h10));

    constant("DICT_APRILTAG_36h11", static_cast<long>(cv::aruco::DICT_APRILTAG_36h11));

    constant("DICT_ARUCO_MIP_36h12", static_cast<long>(cv::aruco::DICT_ARUCO_MIP_36h12));

    constant("DICT_ARUCO_ORIGINAL", static_cast<long>(cv::aruco::DICT_ARUCO_ORIGINAL));

    constant("TEST_CUSTOM", static_cast<long>(cv::detail::TEST_CUSTOM));

    constant("TEST_EQ", static_cast<long>(cv::detail::TEST_EQ));

    constant("TEST_GE", static_cast<long>(cv::detail::TEST_GE));

    constant("TEST_GT", static_cast<long>(cv::detail::TEST_GT));

    constant("TEST_LE", static_cast<long>(cv::detail::TEST_LE));

    constant("TEST_LT", static_cast<long>(cv::detail::TEST_LT));

    constant("TEST_NE", static_cast<long>(cv::detail::TEST_NE));

    constant("TrackerSamplerCSC_MODE_DETECT", static_cast<long>(cv::detail::TrackerSamplerCSC::MODE_DETECT));

    constant("TrackerSamplerCSC_MODE_INIT_NEG", static_cast<long>(cv::detail::TrackerSamplerCSC::MODE_INIT_NEG));

    constant("TrackerSamplerCSC_MODE_INIT_POS", static_cast<long>(cv::detail::TrackerSamplerCSC::MODE_INIT_POS));

    constant("TrackerSamplerCSC_MODE_TRACK_NEG", static_cast<long>(cv::detail::TrackerSamplerCSC::MODE_TRACK_NEG));

    constant("TrackerSamplerCSC_MODE_TRACK_POS", static_cast<long>(cv::detail::TrackerSamplerCSC::MODE_TRACK_POS));

    constant("DNN_BACKEND_CANN", static_cast<long>(cv::dnn::DNN_BACKEND_CANN));

    constant("DNN_BACKEND_CUDA", static_cast<long>(cv::dnn::DNN_BACKEND_CUDA));

    constant("DNN_BACKEND_DEFAULT", static_cast<long>(cv::dnn::DNN_BACKEND_DEFAULT));

    constant("DNN_BACKEND_HALIDE", static_cast<long>(cv::dnn::DNN_BACKEND_HALIDE));

    constant("DNN_BACKEND_INFERENCE_ENGINE", static_cast<long>(cv::dnn::DNN_BACKEND_INFERENCE_ENGINE));

    constant("DNN_BACKEND_OPENCV", static_cast<long>(cv::dnn::DNN_BACKEND_OPENCV));

    constant("DNN_BACKEND_TIMVX", static_cast<long>(cv::dnn::DNN_BACKEND_TIMVX));

    constant("DNN_BACKEND_VKCOM", static_cast<long>(cv::dnn::DNN_BACKEND_VKCOM));

    constant("DNN_BACKEND_WEBNN", static_cast<long>(cv::dnn::DNN_BACKEND_WEBNN));

    constant("DNN_LAYOUT_NCDHW", static_cast<long>(cv::dnn::DNN_LAYOUT_NCDHW));

    constant("DNN_LAYOUT_NCHW", static_cast<long>(cv::dnn::DNN_LAYOUT_NCHW));

    constant("DNN_LAYOUT_ND", static_cast<long>(cv::dnn::DNN_LAYOUT_ND));

    constant("DNN_LAYOUT_NDHWC", static_cast<long>(cv::dnn::DNN_LAYOUT_NDHWC));

    constant("DNN_LAYOUT_NHWC", static_cast<long>(cv::dnn::DNN_LAYOUT_NHWC));

    constant("DNN_LAYOUT_PLANAR", static_cast<long>(cv::dnn::DNN_LAYOUT_PLANAR));

    constant("DNN_LAYOUT_UNKNOWN", static_cast<long>(cv::dnn::DNN_LAYOUT_UNKNOWN));

    constant("DNN_PMODE_CROP_CENTER", static_cast<long>(cv::dnn::DNN_PMODE_CROP_CENTER));

    constant("DNN_PMODE_LETTERBOX", static_cast<long>(cv::dnn::DNN_PMODE_LETTERBOX));

    constant("DNN_PMODE_NULL", static_cast<long>(cv::dnn::DNN_PMODE_NULL));

    constant("DNN_TARGET_CPU", static_cast<long>(cv::dnn::DNN_TARGET_CPU));

    constant("DNN_TARGET_CPU_FP16", static_cast<long>(cv::dnn::DNN_TARGET_CPU_FP16));

    constant("DNN_TARGET_CUDA", static_cast<long>(cv::dnn::DNN_TARGET_CUDA));

    constant("DNN_TARGET_CUDA_FP16", static_cast<long>(cv::dnn::DNN_TARGET_CUDA_FP16));

    constant("DNN_TARGET_FPGA", static_cast<long>(cv::dnn::DNN_TARGET_FPGA));

    constant("DNN_TARGET_HDDL", static_cast<long>(cv::dnn::DNN_TARGET_HDDL));

    constant("DNN_TARGET_MYRIAD", static_cast<long>(cv::dnn::DNN_TARGET_MYRIAD));

    constant("DNN_TARGET_NPU", static_cast<long>(cv::dnn::DNN_TARGET_NPU));

    constant("DNN_TARGET_OPENCL", static_cast<long>(cv::dnn::DNN_TARGET_OPENCL));

    constant("DNN_TARGET_OPENCL_FP16", static_cast<long>(cv::dnn::DNN_TARGET_OPENCL_FP16));

    constant("DNN_TARGET_VULKAN", static_cast<long>(cv::dnn::DNN_TARGET_VULKAN));

    constant("SoftNMSMethod_SOFTNMS_GAUSSIAN", static_cast<long>(cv::dnn::SoftNMSMethod::SOFTNMS_GAUSSIAN));

    constant("SoftNMSMethod_SOFTNMS_LINEAR", static_cast<long>(cv::dnn::SoftNMSMethod::SOFTNMS_LINEAR));

    constant("FISHEYE_CALIB_CHECK_COND", static_cast<long>(cv::fisheye::CALIB_CHECK_COND));

    constant("FISHEYE_CALIB_FIX_FOCAL_LENGTH", static_cast<long>(cv::fisheye::CALIB_FIX_FOCAL_LENGTH));

    constant("FISHEYE_CALIB_FIX_INTRINSIC", static_cast<long>(cv::fisheye::CALIB_FIX_INTRINSIC));

    constant("FISHEYE_CALIB_FIX_K1", static_cast<long>(cv::fisheye::CALIB_FIX_K1));

    constant("FISHEYE_CALIB_FIX_K2", static_cast<long>(cv::fisheye::CALIB_FIX_K2));

    constant("FISHEYE_CALIB_FIX_K3", static_cast<long>(cv::fisheye::CALIB_FIX_K3));

    constant("FISHEYE_CALIB_FIX_K4", static_cast<long>(cv::fisheye::CALIB_FIX_K4));

    constant("FISHEYE_CALIB_FIX_PRINCIPAL_POINT", static_cast<long>(cv::fisheye::CALIB_FIX_PRINCIPAL_POINT));

    constant("FISHEYE_CALIB_FIX_SKEW", static_cast<long>(cv::fisheye::CALIB_FIX_SKEW));

    constant("FISHEYE_CALIB_RECOMPUTE_EXTRINSIC", static_cast<long>(cv::fisheye::CALIB_RECOMPUTE_EXTRINSIC));

    constant("FISHEYE_CALIB_USE_INTRINSIC_GUESS", static_cast<long>(cv::fisheye::CALIB_USE_INTRINSIC_GUESS));

    constant("FISHEYE_CALIB_ZERO_DISPARITY", static_cast<long>(cv::fisheye::CALIB_ZERO_DISPARITY));

    constant("ENUM_LOG_LEVEL_FORCE_INT", static_cast<long>(cv::utils::logging::ENUM_LOG_LEVEL_FORCE_INT));

    constant("LOG_LEVEL_DEBUG", static_cast<long>(cv::utils::logging::LOG_LEVEL_DEBUG));

    constant("LOG_LEVEL_ERROR", static_cast<long>(cv::utils::logging::LOG_LEVEL_ERROR));

    constant("LOG_LEVEL_FATAL", static_cast<long>(cv::utils::logging::LOG_LEVEL_FATAL));

    constant("LOG_LEVEL_INFO", static_cast<long>(cv::utils::logging::LOG_LEVEL_INFO));

    constant("LOG_LEVEL_SILENT", static_cast<long>(cv::utils::logging::LOG_LEVEL_SILENT));

    constant("LOG_LEVEL_VERBOSE", static_cast<long>(cv::utils::logging::LOG_LEVEL_VERBOSE));

    constant("LOG_LEVEL_WARNING", static_cast<long>(cv::utils::logging::LOG_LEVEL_WARNING));

}
